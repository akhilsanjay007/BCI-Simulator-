/** Live tablet input — mutated by BCITrackpad on pointer events (read in parent rAF). */
export type ManualTrackpadDrive = {
  active: boolean;
  nx: number;
  ny: number;
  vx: number;
  vy: number;
  penDown: boolean;
};

export function idleManualTrackpadDrive(): ManualTrackpadDrive {
  return { active: false, nx: 0.5, ny: 0.5, vx: 0, vy: 0, penDown: false };
}
