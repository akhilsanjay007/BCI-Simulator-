import { DASHBOARD_THEME } from "../utils/dashboardTheme";

export interface KeyboardKeyRenderProps {
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  hovered: boolean;
  pressed: boolean;
  swiped: boolean;
  mod: boolean;
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

export function drawKeyboardKey({
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
}: KeyboardKeyRenderProps): void {
  if (width < 2 || height < 2) return;

  const active = hovered || pressed || swiped;
  const T = DASHBOARD_THEME;
  roundRectPath(ctx, x, y, width, height, radius);

  const grad = ctx.createLinearGradient(x, y, x, y + height);
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
  const gloss = ctx.createLinearGradient(x, y, x, y + height * 0.4);
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
  ctx.fillRect(x, y, width, height * 0.45);
  ctx.restore();

  roundRectPath(ctx, x, y, width, height, radius);
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
    const glow = ctx.createRadialGradient(
      x + width / 2,
      y + height,
      0,
      x + width / 2,
      y + height,
      width * 0.85,
    );
    glow.addColorStop(0, pressed ? "rgba(0, 255, 159, 0.12)" : T.accentDim);
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.save();
    roundRectPath(ctx, x, y, width, height, radius);
    ctx.clip();
    ctx.fillStyle = glow;
    ctx.fillRect(x, y - height * 0.2, width, height * 1.4);
    ctx.restore();
  }
}
