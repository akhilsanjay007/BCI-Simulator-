/**
 * Normalized QWERTY keyboard layout for the BCI virtual keyboard surface.
 * Coordinates are in [0, 1]² (x left→right, y top→down).
 */
import { DASHBOARD_THEME } from "./dashboardTheme";

export type KeyDef = {
  id: string;
  label: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Modifier / space bar — slightly different cap styling. */
  mod?: boolean;
};

/** Suggested-word chips along the top of the canvas surface. */
export const SUGGESTIONS_PANEL = {
  x0: 0.04,
  y0: 0.02,
  x1: 0.96,
  y1: 0.17,
} as const;

/** Virtual keyboard fills the lower portion of the canvas. */
export const KEYBOARD_PANEL = {
  x0: 0.04,
  y0: 0.19,
  x1: 0.96,
  y1: 0.98,
} as const;

export type ChipRect = {
  word: string;
  index: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

/** Normalized hit-test expansion (improves edge hover / click reliability). */
const HIT_PAD = 0.008;

const ROW_COUNT = 5;
const ROW_GAP_N = 0.014;
const KEY_GAP_N = 0.008;

/** Standard stagger: indent in key-units from the number row. */
const ROW_INDENT_U: readonly number[] = [0, 0.52, 0.78, 1.18, 0];

type KeySpec = { id: string; label: string; w: number; mod?: boolean };

function panelMetrics(): {
  x0: number;
  y0: number;
  w: number;
  h: number;
  rowH: number;
  unitW: number;
  gapX: number;
} {
  const x0 = KEYBOARD_PANEL.x0;
  const y0 = KEYBOARD_PANEL.y0;
  const w = KEYBOARD_PANEL.x1 - KEYBOARD_PANEL.x0;
  const h = KEYBOARD_PANEL.y1 - KEYBOARD_PANEL.y0;
  const rowH = (h - ROW_GAP_N * (ROW_COUNT - 1)) / ROW_COUNT;
  const gapX = KEY_GAP_N;
  /** Width of one standard character key (number row = 10 units). */
  const unitW = (w - gapX * 9) / 10;
  return { x0, y0, w, h, rowH, unitW, gapX };
}

function rowY0(rowIndex: number, rowH: number, y0: number): number {
  return y0 + rowIndex * (rowH + ROW_GAP_N);
}

function placeRow(
  specs: KeySpec[],
  rowIndex: number,
  indentU: number,
  m: ReturnType<typeof panelMetrics>,
): KeyDef[] {
  const totalU = specs.reduce((s, k) => s + k.w, 0);
  const totalGap = gapCount(specs.length);
  const blockW = totalU * m.unitW + totalGap * m.gapX;
  const maxBlockW = 10 * m.unitW + 9 * m.gapX;
  const centerSlack = (maxBlockW - blockW) / 2;
  let x = m.x0 + centerSlack + indentU * (m.unitW + m.gapX) * 0.5;
  const y0 = rowY0(rowIndex, m.rowH, m.y0);
  const y1 = y0 + m.rowH;

  return specs.map((spec) => {
    const x0 = x;
    const x1 = x0 + spec.w * m.unitW + Math.max(0, spec.w - 1) * m.gapX;
    x = x1 + m.gapX;
    return {
      id: spec.id,
      label: spec.label,
      x0,
      y0,
      x1,
      y1,
      mod: spec.mod,
    };
  });
}

function gapCount(n: number): number {
  return Math.max(0, n - 1);
}

function charRow(chars: string, mod = false): KeySpec[] {
  return [...chars].map((ch) => ({
    id: ch,
    label: ch,
    w: 1,
    mod,
  }));
}

function buildLayout(): KeyDef[] {
  const m = panelMetrics();
  const rows: KeyDef[] = [];

  rows.push(...placeRow(charRow("1234567890"), 0, ROW_INDENT_U[0], m));
  rows.push(...placeRow(charRow("QWERTYUIOP"), 1, ROW_INDENT_U[1], m));
  rows.push(...placeRow(charRow("ASDFGHJKL"), 2, ROW_INDENT_U[2], m));
  rows.push(...placeRow(charRow("ZXCVBNM"), 3, ROW_INDENT_U[3], m));

  const bottom: KeySpec[] = [
    { id: "Backspace", label: "Backspace", w: 1.65, mod: true },
    { id: " ", label: "space", w: 5.2, mod: true },
    { id: "Enter", label: "return", w: 1.65, mod: true },
  ];
  rows.push(...placeRow(bottom, 4, ROW_INDENT_U[4], m));

  return rows;
}

/** All keys in paint / hit-test order. */
export const KEYBOARD_KEYS: readonly KeyDef[] = buildLayout();

function pointInKey(nx: number, ny: number, k: KeyDef): boolean {
  return (
    nx >= k.x0 - HIT_PAD &&
    nx <= k.x1 + HIT_PAD &&
    ny >= k.y0 - HIT_PAD &&
    ny <= k.y1 + HIT_PAD
  );
}

/** Point-in-rect hit test with padding; later keys win on overlap. */
export function hitKey(nx: number, ny: number): KeyDef | null {
  for (let i = KEYBOARD_KEYS.length - 1; i >= 0; i--) {
    const k = KEYBOARD_KEYS[i];
    if (pointInKey(nx, ny, k)) {
      return k;
    }
  }
  return null;
}

const CHIP_PAD = 0.01;
const CHIP_GAP_N = 0.014;
const MAX_CHIPS = 5;

/** Layout up to five suggestion chips inside SUGGESTIONS_PANEL. */
export function layoutSuggestionChips(words: string[]): ChipRect[] {
  const list = words.slice(0, MAX_CHIPS);
  if (list.length === 0) return [];

  const x0 = SUGGESTIONS_PANEL.x0;
  const y0 = SUGGESTIONS_PANEL.y0;
  const w = SUGGESTIONS_PANEL.x1 - SUGGESTIONS_PANEL.x0;
  const h = SUGGESTIONS_PANEL.y1 - SUGGESTIONS_PANEL.y0;
  const gap = CHIP_GAP_N;
  const chipW = (w - gap * (list.length - 1)) / list.length;

  return list.map((word, index) => ({
    word,
    index,
    x0: x0 + index * (chipW + gap),
    y0: y0 + h * 0.06,
    x1: x0 + index * (chipW + gap) + chipW,
    y1: y0 + h * 0.94,
  }));
}

export function hitSuggestion(nx: number, ny: number, words: string[]): ChipRect | null {
  const chips = layoutSuggestionChips(words);
  for (let i = chips.length - 1; i >= 0; i--) {
    const c = chips[i];
    if (
      nx >= c.x0 - CHIP_PAD &&
      nx <= c.x1 + CHIP_PAD &&
      ny >= c.y0 - CHIP_PAD &&
      ny <= c.y1 + CHIP_PAD
    ) {
      return c;
    }
  }
  return null;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function drawKeyCap(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  hovered: boolean,
  pressed: boolean,
  swiped: boolean,
  mod: boolean,
): void {
  if (w < 2 || h < 2) return;

  const active = hovered || pressed || swiped;
  const T = DASHBOARD_THEME;
  roundRectPath(ctx, x, y, w, h, radius);

  const grad = ctx.createLinearGradient(x, y, x, y + h);
  if (pressed) {
    grad.addColorStop(0, "#142820");
    grad.addColorStop(0.5, "#0f1f18");
    grad.addColorStop(1, "#0a0a0a");
  } else if (swiped) {
    grad.addColorStop(0, "#11211a");
    grad.addColorStop(0.5, "#0d1814");
    grad.addColorStop(1, "#0a0a0a");
  } else if (hovered) {
    grad.addColorStop(0, "#1c1c1c");
    grad.addColorStop(0.5, "#141414");
    grad.addColorStop(1, "#0a0a0a");
  } else {
    grad.addColorStop(0, mod ? "#161616" : T.surfaceTop);
    grad.addColorStop(0.55, T.surfaceMid);
    grad.addColorStop(1, T.surfaceBottom);
  }
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.save();
  ctx.clip();
  const gloss = ctx.createLinearGradient(x, y, x, y + h * 0.4);
  if (pressed) {
    gloss.addColorStop(0, "rgba(0, 255, 159, 0.16)");
    gloss.addColorStop(1, "rgba(0, 0, 0, 0)");
  } else if (swiped) {
    gloss.addColorStop(0, "rgba(52, 211, 153, 0.13)");
    gloss.addColorStop(1, "rgba(0, 0, 0, 0)");
  } else if (hovered) {
    gloss.addColorStop(0, "rgba(52, 211, 153, 0.1)");
    gloss.addColorStop(1, "rgba(0, 0, 0, 0)");
  } else {
    gloss.addColorStop(0, "rgba(255, 255, 255, 0.04)");
    gloss.addColorStop(1, "rgba(0, 0, 0, 0)");
  }
  ctx.fillStyle = gloss;
  ctx.fillRect(x, y, w, h * 0.45);
  ctx.restore();

  roundRectPath(ctx, x, y, w, h, radius);
  if (pressed) {
    ctx.strokeStyle = T.accentPressBorder;
    ctx.lineWidth = 1.25;
    ctx.shadowColor = T.accentPressGlow;
    ctx.shadowBlur = 14;
  } else if (swiped) {
    ctx.strokeStyle = T.accentHoverBorder;
    ctx.lineWidth = 1.1;
    ctx.shadowColor = T.accentHoverGlow;
    ctx.shadowBlur = 11;
  } else if (hovered) {
    ctx.strokeStyle = T.accentHoverBorder;
    ctx.lineWidth = 1;
    ctx.shadowColor = T.accentHoverGlow;
    ctx.shadowBlur = 10;
  } else {
    ctx.strokeStyle = T.borderSubtle;
    ctx.lineWidth = 1;
    ctx.shadowBlur = 0;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  if (active) {
    const glow = ctx.createRadialGradient(x + w / 2, y + h, 0, x + w / 2, y + h, w * 0.85);
    glow.addColorStop(0, pressed ? "rgba(0, 255, 159, 0.12)" : T.accentDim);
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.save();
    roundRectPath(ctx, x, y, w, h, radius);
    ctx.clip();
    ctx.fillStyle = glow;
    ctx.fillRect(x, y - h * 0.2, w, h * 1.4);
    ctx.restore();
  }
}

function displayLabel(key: KeyDef): string {
  if (key.id === "Backspace") return "⌫";
  if (key.id === "Enter") return "↵";
  if (key.id === " ") return "";
  return key.label;
}

/** Renders the suggestion chip row; `hoveredIndex` highlights one chip. */
export function drawSuggestions(
  ctx: CanvasRenderingContext2D,
  plotW: number,
  plotH: number,
  words: string[],
  hoveredIndex: number | null,
  pressedIndex: number | null = null,
): void {
  const px = (n: number) => n * plotW;
  const py = (n: number) => n * plotH;
  const chips = layoutSuggestionChips(words);
  if (chips.length === 0) return;

  ctx.save();

  const T = DASHBOARD_THEME;
  const sh = py(SUGGESTIONS_PANEL.y1) - py(SUGGESTIONS_PANEL.y0);
  const chipR = Math.max(6, Math.min(8, sh * 0.2));
  const fontSize = Math.max(13, Math.min(16, sh * 0.44));
  ctx.font = `500 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const chip of chips) {
    const x = px(chip.x0);
    const y = py(chip.y0);
    const w = px(chip.x1) - x;
    const h = py(chip.y1) - y;
    const hovered = chip.index === hoveredIndex;
    const pressed = chip.index === pressedIndex;

    roundRectPath(ctx, x, y, w, h, chipR);
    const g = ctx.createLinearGradient(x, y, x, y + h);
    if (pressed) {
      g.addColorStop(0, "#142820");
      g.addColorStop(1, "#0a0a0a");
    } else if (hovered) {
      g.addColorStop(0, "#1c1c1c");
      g.addColorStop(1, "#0a0a0a");
    } else {
      g.addColorStop(0, T.surfaceTop);
      g.addColorStop(1, T.surfaceBottom);
    }
    ctx.fillStyle = g;
    ctx.fill();

    if (pressed) {
      ctx.strokeStyle = T.accentPressBorder;
      ctx.shadowColor = T.accentPressGlow;
      ctx.shadowBlur = 12;
    } else if (hovered) {
      ctx.strokeStyle = T.accentHoverBorder;
      ctx.shadowColor = T.accentHoverGlow;
      ctx.shadowBlur = 10;
    } else {
      ctx.strokeStyle = T.borderSubtle;
      ctx.shadowBlur = 0;
    }
    ctx.lineWidth = pressed ? 1.25 : 1;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = pressed || hovered ? T.text : "rgba(224, 224, 224, 0.88)";
    ctx.fillText(chip.word, x + w / 2, y + h / 2);
  }

  ctx.restore();
}

/**
 * Renders the virtual keyboard; `hoveredId` / `pressedId` drive cap feedback,
 * `swipedIds` keeps every key brushed during the active drag lit up.
 */
export function drawKeyboard(
  ctx: CanvasRenderingContext2D,
  plotW: number,
  plotH: number,
  hoveredId: string | null,
  pressedId: string | null,
  dpr: number,
  swipedIds: ReadonlySet<string> | null = null,
): void {
  const px = (n: number) => n * plotW;
  const py = (n: number) => n * plotH;

  ctx.save();

  const bh = py(KEYBOARD_PANEL.y1) - py(KEYBOARD_PANEL.y0);
  const keyAreaH = bh;

  const T = DASHBOARD_THEME;
  const charSize = Math.max(13, Math.min(17, keyAreaH * 0.2));
  const modSize = Math.max(11, Math.min(13, keyAreaH * 0.14));
  const radius = Math.max(5, Math.min(7, keyAreaH * 0.075));

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const key of KEYBOARD_KEYS) {
    const kx0 = px(key.x0);
    const ky0 = py(key.y0);
    const kw = px(key.x1) - kx0;
    const kh = py(key.y1) - ky0;
    const hovered = key.id === hoveredId;
    const pressed = key.id === pressedId;
    const swiped = !pressed && swipedIds != null && swipedIds.has(key.id);
    const mod = key.mod === true;

    drawKeyCap(ctx, kx0, ky0, kw, kh, radius, hovered, pressed, swiped, mod);

    const cx = kx0 + kw / 2;
    const cy = ky0 + kh / 2 + (mod ? 0.5 : 0);
    const label = displayLabel(key);
    const active = hovered || pressed || swiped;

    if (key.id === " ") {
      const lineW = Math.min(kw * 0.36, 64);
      roundRectPath(ctx, cx - lineW / 2, cy - 1.5, lineW, 3, 1.5);
      ctx.fillStyle = active ? T.accentDim : "rgba(255, 255, 255, 0.08)";
      ctx.fill();
    } else if (mod) {
      ctx.font = `500 ${modSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
      ctx.fillStyle = active ? T.text : T.textMuted;
      if (label) ctx.fillText(label, cx, cy);
    } else {
      ctx.font = `600 ${charSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
      ctx.fillStyle = active ? T.text : "rgba(224, 224, 224, 0.92)";
      ctx.fillText(label, cx, cy);
    }
  }

  void dpr;
  ctx.restore();
}

/** Normalized cursor sample fed into {@link drawSwipeTrail}. */
export type SwipeTrailPoint = { x: number; y: number };

/**
 * Renders a Gboard-style swipe trail: a quadratic-midpoint smoothed polyline
 * through the actual cursor samples (not key centers), with a wide soft
 * underglow, a medium emerald halo, and a bright top stroke whose alpha fades
 * from tail (dim) to head (bright). Sized + colored to match the dashboard
 * Neuralink palette.
 *
 * Points are normalized [0,1]² so this is layout-independent.
 */
export function drawSwipeTrail(
  ctx: CanvasRenderingContext2D,
  plotW: number,
  plotH: number,
  points: readonly SwipeTrailPoint[],
): void {
  if (points.length < 2) return;
  const T = DASHBOARD_THEME;

  const n = points.length;
  const pts = new Array<SwipeTrailPoint>(n);
  for (let i = 0; i < n; i++) {
    pts[i] = { x: points[i].x * plotW, y: points[i].y * plotH };
  }

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Smoothed path once (quadratic Bezier through midpoints of consecutive pts).
  const smooth = new Path2D();
  smooth.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < n - 1; i++) {
    const xc = (pts[i].x + pts[i + 1].x) / 2;
    const yc = (pts[i].y + pts[i + 1].y) / 2;
    smooth.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
  }
  smooth.lineTo(pts[n - 1].x, pts[n - 1].y);

  // 1) wide soft underglow
  ctx.shadowColor = T.accentPressGlow;
  ctx.shadowBlur = 24;
  ctx.strokeStyle = "rgba(0, 255, 159, 0.14)";
  ctx.lineWidth = 14;
  ctx.stroke(smooth);

  // 2) medium emerald halo
  ctx.shadowBlur = 12;
  ctx.strokeStyle = "rgba(52, 211, 153, 0.32)";
  ctx.lineWidth = 6;
  ctx.stroke(smooth);

  // 3) bright top stroke, per-segment alpha fade (tail dim → head bright).
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(220, 255, 240, 1)";
  ctx.lineWidth = 2.4;

  const denom = Math.max(1, n - 2);
  for (let i = 0; i < n - 1; i++) {
    const t = n === 2 ? 1 : i / denom;
    ctx.globalAlpha = 0.08 + 0.92 * t;
    ctx.beginPath();
    if (i === 0) {
      ctx.moveTo(pts[0].x, pts[0].y);
    } else {
      ctx.moveTo(
        (pts[i - 1].x + pts[i].x) / 2,
        (pts[i - 1].y + pts[i].y) / 2,
      );
    }
    if (i < n - 2) {
      ctx.quadraticCurveTo(
        pts[i].x,
        pts[i].y,
        (pts[i].x + pts[i + 1].x) / 2,
        (pts[i].y + pts[i + 1].y) / 2,
      );
    } else {
      ctx.lineTo(pts[n - 1].x, pts[n - 1].y);
    }
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.restore();
}
