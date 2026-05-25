import { DASHBOARD_THEME } from "../utils/dashboardTheme";
import { SUGGESTIONS_PANEL } from "../utils/keyboardLayout";

export type SuggestionChipRect = {
  word: string;
  index: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

const CHIP_PAD = 0.01;
const CHIP_GAP_N = 0.014;
const MAX_CHIPS = 5;

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

export function layoutSuggestionChips(words: string[]): SuggestionChipRect[] {
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

export function hitSuggestion(nx: number, ny: number, words: string[]): SuggestionChipRect | null {
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

export interface SuggestionBarProps {
  ctx: CanvasRenderingContext2D;
  plotW: number;
  plotH: number;
  words: string[];
  hoveredIndex: number | null;
  pressedIndex?: number | null;
}

export function drawSuggestionBar({
  ctx,
  plotW,
  plotH,
  words,
  hoveredIndex,
  pressedIndex = null,
}: SuggestionBarProps): void {
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
