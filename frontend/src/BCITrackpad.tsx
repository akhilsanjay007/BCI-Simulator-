import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
} from "react";
import { idleManualTrackpadDrive, type ManualTrackpadDrive } from "./manualTrackpad";

const BG = "#050505";
const INK_GLOW = "rgba(52, 211, 153, 0.48)";
const INK_HALO = "rgba(0, 255, 170, 0.22)";
/** Soft cyan grid — #22ffaa @ ~10% opacity */
const GRID_STROKE = "rgba(34, 255, 170, 0.1)";
const GRID_GLOW = "rgba(34, 255, 170, 0.06)";
const CURSOR_CORE = "#c8fff0";
const CURSOR_RING = "rgba(0, 255, 200, 0.85)";

type NormPoint = { x: number; y: number };

/** Sample on the pad: position + speed magnitude for simulated pressure (line width). */
type StrokePoint = NormPoint & { v: number };

interface BCITrackpadProps {
  controlMode: "automatic" | "manual";
  /** Normalized cursor [0,1]² — decoder or keyboard-smoothed physics. */
  cursorNorm: NormPoint;
  /** Velocity for HUD when not driving from tablet ref (decoder / keyboard). */
  vx: number;
  vy: number;
  /** Pen / contact (decoder or lifted from tablet ref in manual). */
  penDown: boolean;
  /** Manual mode: absolute hover + click-drag ink; updated every pointer event. */
  manualDriveRef: MutableRefObject<ManualTrackpadDrive>;
  /** Appends one recognized character to the thought-to-text panel. */
  onRecognizeLetter: (letter: string) => void;
  /** Stroke too short or recognizer error (message only). */
  onRecognizeError?: (message: string) => void;
  /** Ink cleared — reset current-letter display in App (full sentence unchanged). */
  onCanvasCleared?: () => void;
  className?: string;
}

export type BCITrackpadHandle = {
  recognize: () => void;
  clearCanvas: () => void;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

const DEMO_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ ";

/** Deterministic demo glyph from stroke geometry until backend recognizer is wired. */
function demoLetterFromStrokes(strokes: StrokePoint[][]): string {
  const pts = strokes.flat();
  if (pts.length < 8) return "";
  let hash = pts.length;
  for (const p of pts) {
    hash = (hash * 31 + Math.floor(p.x * 997) + Math.floor(p.y * 991)) >>> 0;
  }
  return DEMO_ALPHABET[hash % DEMO_ALPHABET.length];
}

/** Cell size that scales with canvas (~32 divisions on long edge). */
function gridCellPx(plotW: number, plotH: number): number {
  const long = Math.max(plotW, plotH);
  const ideal = long / 32;
  const steps = [16, 18, 20, 22, 24, 28, 32, 36, 40, 48];
  return steps.reduce((best, s) => (Math.abs(s - ideal) < Math.abs(best - ideal) ? s : best));
}

function fillScopeBackground(ctx: CanvasRenderingContext2D, plotW: number, plotH: number): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, plotW, plotH);
}

/** Single-level grid — minimal cyan lines with a faint glow. */
function drawGrid(ctx: CanvasRenderingContext2D, plotW: number, plotH: number, dpr: number): void {
  const cell = gridCellPx(plotW, plotH);
  const cols = Math.ceil(plotW / cell);
  const rows = Math.ceil(plotH / cell);
  const lineW = dpr >= 2 ? 0.8 : 1;

  ctx.save();
  ctx.beginPath();
  for (let i = 0; i <= cols; i++) {
    const px = Math.floor(Math.min(plotW, i * cell)) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, plotH);
  }
  for (let j = 0; j <= rows; j++) {
    const py = Math.floor(Math.min(plotH, j * cell)) + 0.5;
    ctx.moveTo(0, py);
    ctx.lineTo(plotW, py);
  }

  ctx.lineCap = "butt";
  ctx.strokeStyle = GRID_STROKE;
  ctx.lineWidth = lineW;
  ctx.shadowColor = GRID_GLOW;
  ctx.shadowBlur = 2;
  ctx.stroke();
  ctx.restore();
}

function formatHud(vx: number, vy: number, pen: boolean): { line1: string; line2: string } {
  const mag = Math.hypot(vx, vy);
  const line1 = `vx ${vx >= 0 ? "+" : ""}${vx.toFixed(2)}  vy ${vy >= 0 ? "+" : ""}${vy.toFixed(2)}  |v| ${mag.toFixed(2)}`;
  const line2 = `pen ${pen ? "DOWN" : "up"}`;
  return { line1, line2 };
}

/** Faster motion ⇒ slightly thicker stroke (digital pen feel). */
function strokeWidthFromSpeed(v: number): number {
  const t = clamp(v / 1.15, 0, 1);
  return 1.75 + t * 6.25;
}

function toPx(p: NormPoint, plotW: number, plotH: number): { x: number; y: number } {
  return {
    x: clamp(p.x, 0, 1) * plotW,
    y: clamp(p.y, 0, 1) * plotH,
  };
}

/** Densify sparse jumps so width + caps look continuous. */
function densifyStroke(stroke: StrokePoint[], maxStepPx: number): StrokePoint[] {
  if (stroke.length < 2) return stroke.slice();
  const out: StrokePoint[] = [stroke[0]];
  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1];
    const b = stroke[i];
    const ax = a.x;
    const ay = a.y;
    const bx = b.x;
    const by = b.y;
    const dx = bx - ax;
    const dy = by - ay;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-8) continue;
    const steps = Math.min(14, Math.max(0, Math.ceil(dist / maxStepPx) - 1));
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      out.push({
        x: ax + dx * t,
        y: ay + dy * t,
        v: a.v * (1 - t) + b.v * t,
      });
    }
    out.push(b);
  }
  return out;
}

/** Laplacian-style light smooth (2 passes) for ink preview — keeps endpoints fixed. */
function lightSmoothStroke(stroke: StrokePoint[]): StrokePoint[] {
  if (stroke.length < 3) return stroke;
  const once = (pts: StrokePoint[]): StrokePoint[] => {
    const o: StrokePoint[] = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const c = pts[i + 1];
      o.push({
        x: 0.2 * a.x + 0.6 * b.x + 0.2 * c.x,
        y: 0.2 * a.y + 0.6 * b.y + 0.2 * c.y,
        v: (a.v + 2 * b.v + c.v) / 4,
      });
    }
    o.push(pts[pts.length - 1]);
    return o;
  };
  return once(once(stroke));
}

function strokeForRender(stroke: StrokePoint[]): StrokePoint[] {
  if (stroke.length < 2) return stroke;
  const smoothed = lightSmoothStroke(stroke);
  return smoothed.length >= 2 ? smoothed : stroke;
}

/** Soft smooth silhouette (quadratic midpoints) under variable-width ink. */
function drawSmoothQuadraticUnderlay(
  ctx: CanvasRenderingContext2D,
  stroke: StrokePoint[],
  plotW: number,
  plotH: number,
): void {
  if (stroke.length < 2) return;
  const d = densifyStroke(stroke, 2.8);
  const px = d.map((p) => toPx(p, plotW, plotH));
  ctx.save();
  ctx.strokeStyle = "rgba(52, 211, 153, 0.28)";
  ctx.shadowColor = "rgba(0, 255, 170, 0.35)";
  ctx.shadowBlur = 12;
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(px[0].x, px[0].y);
  if (px.length === 2) {
    ctx.lineTo(px[1].x, px[1].y);
  } else {
    for (let i = 1; i < px.length - 1; i++) {
      const xc = (px[i].x + px[i + 1].x) / 2;
      const yc = (px[i].y + px[i + 1].y) / 2;
      ctx.quadraticCurveTo(px[i].x, px[i].y, xc, yc);
    }
    ctx.quadraticCurveTo(px[px.length - 2].x, px[px.length - 2].y, px[px.length - 1].x, px[px.length - 1].y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.restore();
}

/** Variable-width ink along smoothed polyline (dense samples + round caps). */
function drawPenStroke(
  ctx: CanvasRenderingContext2D,
  stroke: StrokePoint[],
  plotW: number,
  plotH: number,
  alphaScale: number,
): void {
  if (stroke.length < 2) return;
  const dense = densifyStroke(stroke, 2.4);
  const px = dense.map((p) => toPx(p, plotW, plotH));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 0; i < px.length - 1; i++) {
    const w = strokeWidthFromSpeed((dense[i].v + dense[i + 1].v) / 2);
    const a = alphaScale;
    ctx.lineWidth = w + 3;
    ctx.strokeStyle = `rgba(0, 255, 170, ${0.22 * a})`;
    ctx.shadowColor = `rgba(52, 211, 153, ${0.65 * a})`;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(px[i].x, px[i].y);
    ctx.lineTo(px[i + 1].x, px[i + 1].y);
    ctx.stroke();

    ctx.shadowBlur = 8;
    ctx.lineWidth = w;
    ctx.strokeStyle = `rgba(110, 231, 183, ${0.92 * a})`;
    ctx.beginPath();
    ctx.moveTo(px[i].x, px[i].y);
    ctx.lineTo(px[i + 1].x, px[i + 1].y);
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(1.2, w * 0.45);
    ctx.strokeStyle = `rgba(220, 255, 245, ${0.55 * a})`;
    ctx.beginPath();
    ctx.moveTo(px[i].x, px[i].y);
    ctx.lineTo(px[i + 1].x, px[i + 1].y);
    ctx.stroke();
  }
}

function normFromClient(wrap: HTMLDivElement, clientX: number, clientY: number): NormPoint {
  const r = wrap.getBoundingClientRect();
  const nx = clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
  const ny = clamp((clientY - r.top) / Math.max(1, r.height), 0, 1);
  return { x: nx, y: ny };
}

/**
 * Drawing surface: full pad rect in normalized coords; square frame from parent.
 * rAF paint reads merged cursor/pen (tablet ref in Manual removes one frame of lag).
 */
export const BCITrackpad = forwardRef<BCITrackpadHandle, BCITrackpadProps>(function BCITrackpad(
  {
    controlMode,
    cursorNorm,
    vx,
    vy,
    penDown,
    manualDriveRef,
    onRecognizeLetter,
    onRecognizeError,
    onCanvasCleared,
    className = "",
  },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<StrokePoint[][]>([]);
  const activeStrokeRef = useRef<StrokePoint[] | null>(null);
  const lastInkNormRef = useRef<NormPoint | null>(null);
  const lastCanvasLayoutRef = useRef({ plotW: 0, plotH: 0, dpr: 0 });

  const velTrackRef = useRef({ nx: 0.5, ny: 0.5, t: performance.now() });

  const liveRef = useRef({
    cursorNorm,
    vx,
    vy,
    penDown,
    controlMode,
  });

  useLayoutEffect(() => {
    liveRef.current = { cursorNorm, vx, vy, penDown, controlMode };
  }, [cursorNorm, vx, vy, penDown, controlMode]);

  const pushInkPoint = useCallback((p: StrokePoint) => {
    const last = lastInkNormRef.current;
    const dx = last ? p.x - last.x : 1;
    const dy = last ? p.y - last.y : 1;
    if (last && dx * dx + dy * dy < 8e-8) return;
    lastInkNormRef.current = { x: p.x, y: p.y };
    let stroke = activeStrokeRef.current;
    if (!stroke) {
      stroke = [];
      activeStrokeRef.current = stroke;
      strokesRef.current.push(stroke);
    }
    stroke.push({ ...p });
  }, []);

  const closeStroke = useCallback(() => {
    activeStrokeRef.current = null;
    lastInkNormRef.current = null;
  }, []);

  const mergedLive = useCallback(() => {
    const L = liveRef.current;
    const pad = manualDriveRef.current;
    if (L.controlMode === "manual" && pad.active) {
      return {
        cursorNorm: { x: pad.nx, y: pad.ny },
        vx: pad.vx,
        vy: pad.vy,
        penDown: pad.penDown,
        controlMode: L.controlMode,
      };
    }
    return {
      cursorNorm: L.cursorNorm,
      vx: L.vx,
      vy: L.vy,
      penDown: L.penDown,
      controlMode: L.controlMode,
    };
  }, [manualDriveRef]);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const plotW = Math.max(200, Math.floor(wrap.clientWidth));
    const plotH = Math.max(160, Math.floor(wrap.clientHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const prev = lastCanvasLayoutRef.current;
    if (prev.plotW !== plotW || prev.plotH !== plotH || prev.dpr !== dpr) {
      lastCanvasLayoutRef.current = { plotW, plotH, dpr };
      canvas.width = Math.floor(plotW * dpr);
      canvas.height = Math.floor(plotH * dpr);
      canvas.style.width = `${plotW}px`;
      canvas.style.height = `${plotH}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    fillScopeBackground(ctx, plotW, plotH);
    drawGrid(ctx, plotW, plotH, dpr);

    const M = mergedLive();
    const cx = clamp(M.cursorNorm.x, 0, 1) * plotW;
    const cy = clamp(M.cursorNorm.y, 0, 1) * plotH;
    const t = performance.now() / 1000;
    const pulse = 0.82 + 0.18 * Math.sin(t * 5.5);

    const inkNow =
      M.penDown && (M.controlMode === "automatic" || manualDriveRef.current.active);

    const drawCursorGlow = (compact: boolean) => {
      const rOuter = compact ? 26 : 52;
      const rMid = compact ? 14 : 28;
      const rCore = compact ? 4.5 : 6.5;
      const rHot = compact ? 2.8 : 4;

      const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, rOuter);
      bloom.addColorStop(0, `rgba(0, 255, 190, ${compact ? 0.22 * pulse : 0.32 * pulse})`);
      bloom.addColorStop(0.35, `rgba(0, 255, 170, ${compact ? 0.1 * pulse : 0.16 * pulse})`);
      bloom.addColorStop(0.7, "rgba(52, 211, 153, 0.04)");
      bloom.addColorStop(1, "rgba(0, 255, 170, 0)");
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
      ctx.fill();

      const mid = ctx.createRadialGradient(cx, cy, 0, cx, cy, rMid);
      mid.addColorStop(0, `rgba(120, 255, 220, ${0.55 * pulse})`);
      mid.addColorStop(0.5, `rgba(0, 255, 170, ${0.2 * pulse})`);
      mid.addColorStop(1, "rgba(0, 255, 170, 0)");
      ctx.fillStyle = mid;
      ctx.beginPath();
      ctx.arc(cx, cy, rMid, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = CURSOR_RING;
      ctx.lineWidth = compact ? 1.5 : 2;
      ctx.shadowColor = "rgba(0, 255, 200, 0.95)";
      ctx.shadowBlur = compact ? 14 : 28;
      ctx.fillStyle = CURSOR_CORE;
      ctx.beginPath();
      ctx.arc(cx, cy, rCore, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.shadowBlur = compact ? 10 : 22;
      ctx.beginPath();
      ctx.arc(cx, cy, rHot, 0, Math.PI * 2);
      ctx.fillStyle = "#e8fff8";
      ctx.fill();
      ctx.shadowBlur = 0;
    };

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const stroke of strokesRef.current) {
      if (stroke.length < 2) continue;
      const sm = strokeForRender(stroke);
      const dense = densifyStroke(sm, 5);
      const px = dense.map((p) => toPx(p, plotW, plotH));
      ctx.strokeStyle = INK_GLOW;
      ctx.shadowColor = "rgba(52, 211, 153, 0.5)";
      ctx.shadowBlur = 16;
      ctx.lineWidth = 16;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(px[0].x, px[0].y);
      for (let i = 1; i < px.length - 1; i++) {
        const xc = (px[i].x + px[i + 1].x) / 2;
        const yc = (px[i].y + px[i + 1].y) / 2;
        ctx.quadraticCurveTo(px[i].x, px[i].y, xc, yc);
      }
      ctx.quadraticCurveTo(px[px.length - 2].x, px[px.length - 2].y, px[px.length - 1].x, px[px.length - 1].y);
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = INK_HALO;
      ctx.lineWidth = 28;
      ctx.globalAlpha = 0.62;
      ctx.beginPath();
      ctx.moveTo(px[0].x, px[0].y);
      for (let i = 1; i < px.length - 1; i++) {
        const xc = (px[i].x + px[i + 1].x) / 2;
        const yc = (px[i].y + px[i + 1].y) / 2;
        ctx.quadraticCurveTo(px[i].x, px[i].y, xc, yc);
      }
      ctx.quadraticCurveTo(px[px.length - 2].x, px[px.length - 2].y, px[px.length - 1].x, px[px.length - 1].y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    for (const stroke of strokesRef.current) {
      if (stroke.length < 2) continue;
      const sm = strokeForRender(stroke);
      drawSmoothQuadraticUnderlay(ctx, sm, plotW, plotH);
      drawPenStroke(ctx, sm, plotW, plotH, 1);
    }

    const active = activeStrokeRef.current;
    if (active && active.length >= 2) {
      const smA = strokeForRender(active);
      drawSmoothQuadraticUnderlay(ctx, smA, plotW, plotH);
      drawPenStroke(ctx, smA, plotW, plotH, 1);
      const tail = smA.slice(-14);
      if (tail.length >= 2) {
        drawPenStroke(ctx, tail, plotW, plotH, 0.52);
      }
    }

    if (!inkNow) {
      drawCursorGlow(false);
    } else {
      drawCursorGlow(true);
    }

    const { line1, line2 } = formatHud(M.vx, M.vy, M.penDown);
    ctx.save();
    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", monospace';
    const tw = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width);
    const bx = 12;
    const bh = 42;
    const by = plotH - bh - 12;
    const bw = Math.min(plotW - 24, tw + 24);
    ctx.fillStyle = "rgba(0,0,0,0.78)";
    ctx.strokeStyle = M.penDown ? "rgba(52, 211, 153, 0.45)" : "rgba(255,255,255,0.1)";
    ctx.lineWidth = 1;
    const r = 8;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + bw - r, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
    ctx.lineTo(bx + bw, by + bh - r);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
    ctx.lineTo(bx + r, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
    ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(220, 245, 238, 0.96)";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(line1, bx + 12, by + 17);
    ctx.fillStyle = M.penDown ? "rgba(110, 231, 183, 0.98)" : "rgba(160, 180, 175, 0.9)";
    ctx.fillText(line2, bx + 12, by + 33);
    ctx.restore();
  }, [manualDriveRef, mergedLive]);

  const clearInk = useCallback(() => {
    const strokeCount = strokesRef.current.length;
    strokesRef.current = [];
    activeStrokeRef.current = null;
    lastInkNormRef.current = null;
    onCanvasCleared?.();
    console.log(`[BCITrackpad] clearInk: removed ${strokeCount} stroke(s)`);
    paint();
  }, [onCanvasCleared, paint]);

  useLayoutEffect(() => {
    paint();
  }, [paint, controlMode]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => paint());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [paint]);

  useEffect(() => {
    let raf = 0;

    const tick = () => {
      const M = mergedLive();
      const ink =
        M.penDown && (M.controlMode === "automatic" || manualDriveRef.current.active);

      if (ink) {
        const v = Math.hypot(M.vx, M.vy);
        pushInkPoint({
          x: M.cursorNorm.x,
          y: M.cursorNorm.y,
          v: clamp(v, 0, 1.6),
        });
      } else {
        closeStroke();
      }

      paint();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [paint, pushInkPoint, closeStroke, mergedLive, manualDriveRef]);

  const estimateVelocity = useCallback((nx: number, ny: number) => {
    const now = performance.now();
    const prev = velTrackRef.current;
    const dt = (now - prev.t) / 1000;
    if (dt > 0.07) {
      velTrackRef.current = { nx, ny, t: now };
      return { vx: 0, vy: 0 };
    }
    const dnx = nx - prev.nx;
    const dny = ny - prev.ny;
    velTrackRef.current = { nx, ny, t: now };
    const scale = 2.4;
    const effDt = Math.max(1e-4, dt);
    return {
      vx: clamp(dnx / effDt / scale, -1, 1),
      vy: clamp(dny / effDt / scale, -1, 1),
    };
  }, []);

  const writeDriveFromEvent = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const wrap = wrapRef.current;
      if (!wrap || controlMode !== "manual") return;

      const r = wrap.getBoundingClientRect();
      const inside =
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom;
      const dragging = (e.buttons & 1) !== 0;
      const active = inside || dragging;

      const { x: nx, y: ny } = normFromClient(wrap, e.clientX, e.clientY);
      const { vx: evx, vy: evy } = estimateVelocity(nx, ny);
      const penDownBtn = (e.buttons & 1) !== 0;

      manualDriveRef.current = {
        active,
        nx,
        ny,
        vx: active ? evx : 0,
        vy: active ? evy : 0,
        penDown: active && penDownBtn,
      };
    },
    [controlMode, estimateVelocity, manualDriveRef],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (controlMode !== "manual") return;
    if (e.button === 0) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    writeDriveFromEvent(e);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (controlMode !== "manual") return;
    writeDriveFromEvent(e);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    writeDriveFromEvent(e);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onPointerLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    if (controlMode !== "manual") return;
    if (e.buttons === 0) {
      manualDriveRef.current = idleManualTrackpadDrive();
    } else {
      writeDriveFromEvent(e);
    }
  };

  const onRecognize = useCallback(() => {
    const strokes = strokesRef.current;
    const pts = strokes.reduce((a, s) => a + s.length, 0);
    if (pts < 8) {
      onRecognizeError?.("Stroke too short — draw a letter, then Recognize.");
      return;
    }
    const letter = demoLetterFromStrokes(strokes);
    onRecognizeLetter(letter);
    strokesRef.current = [];
    activeStrokeRef.current = null;
    lastInkNormRef.current = null;
    onCanvasCleared?.();
    paint();
  }, [onRecognizeLetter, onRecognizeError, onCanvasCleared, paint]);

  const imperativeRef = useRef<BCITrackpadHandle>({
    recognize: () => {},
    clearCanvas: () => {},
  });
  imperativeRef.current = {
    recognize: onRecognize,
    clearCanvas: clearInk,
  };

  useImperativeHandle(
    ref,
    () => ({
      recognize: () => imperativeRef.current.recognize(),
      clearCanvas: () => imperativeRef.current.clearCanvas(),
    }),
    [],
  );

  return (
    <div className={`relative h-full w-full min-h-0 min-w-0 ${className}`}>
      <div
        ref={wrapRef}
        role="application"
        aria-label="BCI drawing tablet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        className={`relative h-full w-full min-h-0 min-w-0 rounded-2xl border border-emerald-400/25 bg-[#050505] overflow-hidden touch-none select-none shadow-[inset_0_0_48px_rgba(0,255,170,0.04),inset_0_1px_0_rgba(52,211,153,0.12),0_0_0_1px_rgba(0,0,0,0.7),0_28px_90px_-24px_rgba(0,255,159,0.2)] transition-shadow duration-500 hover:border-emerald-400/35 hover:shadow-[inset_0_0_56px_rgba(0,255,170,0.06),inset_0_1px_0_rgba(52,211,153,0.16),0_32px_100px_-20px_rgba(0,255,159,0.28)] ${
          controlMode === "manual" ? "cursor-none" : "cursor-default"
        }`}
      >
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 block h-full w-full"
          aria-hidden
        />
      </div>
    </div>
  );
});
BCITrackpad.displayName = "BCITrackpad";
