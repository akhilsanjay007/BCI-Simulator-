/**
 * Client-side mirror of app/decoder.py velocity cursor integration so Manual Mode
 * matches Automatic Mode smoothing without backend changes.
 */

export type ManualIntent = "left" | "right" | "up" | "down" | "rest";

/** Match decoder defaults (see app/decoder.py). */
export const CURSOR_MAX_SPEED_PER_S = 0.85;
export const CURSOR_VEL_TRACKING_PER_S = 14.0;
export const CURSOR_VEL_DAMPING_PER_S = 2.0;
export const CURSOR_REST_EXTRA_DAMPING_PER_S = 5.0;
export const CURSOR_WEAK_INTENT_DAMPING_PER_S = 4.0;
/** Must match BciDecoder cursor_smooth_alpha default in decoder.py */
export const CURSOR_SMOOTH_ALPHA = 0.22;

/** Manual control uses fixed high confidence (decoder applies gain ** 0.88). Display as 95%. */
export const MANUAL_CONTROL_CONFIDENCE = 0.95;

export interface CursorMotionState {
  xRaw: number;
  yRaw: number;
  vx: number;
  vy: number;
  xSmooth: number;
  ySmooth: number;
}

export function seedCursorMotion(x: number, y: number): CursorMotionState {
  return {
    xRaw: x,
    yRaw: y,
    vx: 0,
    vy: 0,
    xSmooth: x,
    ySmooth: y,
  };
}

function intentVelocityDirection(intent: ManualIntent): [number, number] {
  switch (intent) {
    case "right":
      return [1, 0];
    case "left":
      return [-1, 0];
    case "up":
      return [0, -1];
    case "down":
      return [0, 1];
    default:
      return [0, 0];
  }
}

/**
 * One timestep of velocity integration + display EMA (same structure as BciDecoder._step_cursor).
 */
export function stepCursorMotion(
  s: CursorMotionState,
  intent: ManualIntent,
  confidence: number,
  dt_s: number,
): CursorMotionState {
  if (dt_s <= 0) return s;

  const conf = Math.min(1, Math.max(0, confidence));
  const [dirX, dirY] = intentVelocityDirection(intent);

  let targetVx: number;
  let targetVy: number;
  let drive: number;
  if (intent === "rest") {
    targetVx = 0;
    targetVy = 0;
    drive = 0;
  } else {
    const gain = conf ** 0.88;
    targetVx = dirX * CURSOR_MAX_SPEED_PER_S * gain;
    targetVy = dirY * CURSOR_MAX_SPEED_PER_S * gain;
    drive = conf;
  }

  let vx = s.vx + CURSOR_VEL_TRACKING_PER_S * (targetVx - s.vx) * dt_s;
  let vy = s.vy + CURSOR_VEL_TRACKING_PER_S * (targetVy - s.vy) * dt_s;

  let dampTotal = CURSOR_VEL_DAMPING_PER_S;
  if (intent === "rest") {
    dampTotal += CURSOR_REST_EXTRA_DAMPING_PER_S;
  } else {
    dampTotal += CURSOR_WEAK_INTENT_DAMPING_PER_S * (1 - drive);
  }
  const dampFactor = Math.exp(-dampTotal * dt_s);
  vx *= dampFactor;
  vy *= dampFactor;

  const x = Math.min(1, Math.max(0, s.xRaw + vx * dt_s));
  const y = Math.min(1, Math.max(0, s.yRaw + vy * dt_s));

  if (x <= 0 && vx < 0) vx = 0;
  if (x >= 1 && vx > 0) vx = 0;
  if (y <= 0 && vy < 0) vy = 0;
  if (y >= 1 && vy > 0) vy = 0;

  const a = CURSOR_SMOOTH_ALPHA;
  const xSmooth = a * x + (1 - a) * s.xSmooth;
  const ySmooth = a * y + (1 - a) * s.ySmooth;

  return { xRaw: x, yRaw: y, vx, vy, xSmooth, ySmooth };
}
