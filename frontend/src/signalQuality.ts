/** Smoothed signal quality tier for UI coloring. */
export type SignalTier = "good" | "medium" | "poor";

export interface SignalQualityInput {
  /** Decoder epistemic confidence [0, 1]. */
  confidence: number;
  penDown: boolean;
  /** Command speed |v| in normalized units. */
  velocityMag: number;
  /** Manual burst envelope × spike confidence [0, 1]. */
  spikeStrength: number;
  /** Seconds since pen lifted (0 while pen is down). */
  penUpIdleSec: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Instantaneous neural signal quality [0, 1].
 * High when firing proxy + decoder confidence are strong; decays with pen-up idle.
 */
export function computeInstantSignalQuality(input: SignalQualityInput): number {
  const conf = clamp(input.confidence, 0, 1);
  const vel = clamp(input.velocityMag, 0, 1.6);
  const spike = clamp(input.spikeStrength, 0, 1);

  const velActivity = clamp(vel / 0.9, 0, 1);
  const firingProxy = input.penDown
    ? clamp(0.2 + velActivity * 0.45 + spike * 0.4, 0, 1)
    : clamp(spike * 0.35, 0, 0.45);

  const idleMul = input.penDown ? 1 : clamp(Math.exp(-input.penUpIdleSec / 2.4), 0.1, 1);

  const blend = conf * 0.5 + firingProxy * 0.5;
  return clamp(blend * idleMul, 0, 1);
}

/** EMA smoothing time constant (seconds). */
export const SIGNAL_SMOOTH_TAU_S = 0.24;

export function stepSignalSmooth(prev: number, target: number, dtSec: number): number {
  const alpha = 1 - Math.exp(-dtSec / SIGNAL_SMOOTH_TAU_S);
  return prev + (target - prev) * alpha;
}

export function signalTierFromPct(pct: number): SignalTier {
  if (pct >= 68) return "good";
  if (pct >= 38) return "medium";
  return "poor";
}

export function signalTierStyles(tier: SignalTier): {
  text: string;
  dot: string;
  border: string;
  bar: string;
} {
  switch (tier) {
    case "good":
      return {
        text: "text-emerald-300",
        dot: "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.85)]",
        border: "border-emerald-500/40",
        bar: "from-emerald-950 via-emerald-400 to-emerald-100",
      };
    case "medium":
      return {
        text: "text-amber-300",
        dot: "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.75)]",
        border: "border-amber-500/40",
        bar: "from-amber-950 via-amber-400 to-amber-100",
      };
    case "poor":
      return {
        text: "text-red-300",
        dot: "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.75)]",
        border: "border-red-500/35",
        bar: "from-red-950 via-red-500 to-red-300",
      };
  }
}
