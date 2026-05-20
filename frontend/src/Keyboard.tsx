import { DASHBOARD_THEME } from "./dashboardTheme";
import { KEYBOARD_KEYS } from "./keyboardLayout";
import { drawKeyboardKey } from "./KeyboardKey";

function displayLabel(keyId: string, label: string): string {
  if (keyId === "Backspace") return "⌫";
  if (keyId === "Enter") return "↵";
  if (keyId === " ") return "";
  return label;
}

export interface KeyboardProps {
  ctx: CanvasRenderingContext2D;
  plotW: number;
  plotH: number;
  hoveredId: string | null;
  pressedId: string | null;
  dpr: number;
  swipedIds?: ReadonlySet<string> | null;
}

export function drawKeyboard({
  ctx,
  plotW,
  plotH,
  hoveredId,
  pressedId,
  dpr,
  swipedIds = null,
}: KeyboardProps): void {
  const px = (n: number) => n * plotW;
  const py = (n: number) => n * plotH;

  ctx.save();

  const keyAreaH = py(0.98) - py(0.19);
  const T = DASHBOARD_THEME;
  const charSize = Math.max(13, Math.min(17, keyAreaH * 0.2));
  const modSize = Math.max(11, Math.min(13, keyAreaH * 0.14));
  const radius = Math.max(5, Math.min(7, keyAreaH * 0.075));

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const key of KEYBOARD_KEYS) {
    const x = px(key.x0);
    const y = py(key.y0);
    const width = px(key.x1) - x;
    const height = py(key.y1) - y;
    const hovered = key.id === hoveredId;
    const pressed = key.id === pressedId;
    const swiped = !pressed && swipedIds != null && swipedIds.has(key.id);
    const mod = key.mod === true;

    drawKeyboardKey({
      ctx,
      x,
      y,
      width,
      height,
      radius,
      hovered,
      pressed,
      swiped,
      mod,
    });

    const cx = x + width / 2;
    const cy = y + height / 2 + (mod ? 0.5 : 0);
    const label = displayLabel(key.id, key.label);
    const active = hovered || pressed || swiped;

    if (key.id === " ") {
      const lineW = Math.min(width * 0.36, 64);
      ctx.beginPath();
      const lx = cx - lineW / 2;
      const ly = cy - 1.5;
      const lw = lineW;
      const lh = 3;
      const r = 1.5;
      ctx.moveTo(lx + r, ly);
      ctx.lineTo(lx + lw - r, ly);
      ctx.quadraticCurveTo(lx + lw, ly, lx + lw, ly + r);
      ctx.lineTo(lx + lw, ly + lh - r);
      ctx.quadraticCurveTo(lx + lw, ly + lh, lx + lw - r, ly + lh);
      ctx.lineTo(lx + r, ly + lh);
      ctx.quadraticCurveTo(lx, ly + lh, lx, ly + lh - r);
      ctx.lineTo(lx, ly + r);
      ctx.quadraticCurveTo(lx, ly, lx + r, ly);
      ctx.closePath();
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
