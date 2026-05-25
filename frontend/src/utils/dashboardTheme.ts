/**
 * Shared dashboard palette — mirrors Tailwind tokens on decoder / signal panels.
 * Use for canvas drawing where CSS classes do not apply.
 */
export const DASHBOARD_THEME = {
  bg: "#0a0a0a",
  surfaceTop: "#171717",
  surfaceMid: "#121212",
  surfaceBottom: "#0a0a0a",
  border: "rgba(38, 38, 38, 0.9)",
  borderSubtle: "rgba(255, 255, 255, 0.06)",
  accent: "#34d399",
  accentBright: "#00ff9f",
  accentDim: "rgba(52, 211, 153, 0.35)",
  accentHoverBorder: "rgba(52, 211, 153, 0.45)",
  accentHoverGlow: "rgba(52, 211, 153, 0.35)",
  accentPressBorder: "rgba(0, 255, 159, 0.65)",
  accentPressGlow: "rgba(0, 255, 159, 0.4)",
  text: "#e0e0e0",
  textMuted: "#a3a3a3",
  textDim: "#737373",
  cursorCore: "#c8fff0",
  cursorRing: "rgba(52, 211, 153, 0.85)",
} as const;

/** Tailwind class strings reused across dashboard cards. */
export const DASHBOARD_PANEL =
  "rounded-xl border border-neutral-800/90 bg-gradient-to-b from-neutral-900/70 to-black/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]";

export const DASHBOARD_PANEL_HEADER =
  "text-[10px] font-mono font-semibold uppercase tracking-[0.2em] text-neutral-400";

export const DASHBOARD_INNER_SURFACE = "bg-black/30";

export const DASHBOARD_DIVIDER = "border-neutral-800/80";

export const DASHBOARD_BTN =
  "rounded-lg border border-neutral-600/80 text-neutral-300 text-[10px] font-medium hover:bg-neutral-800/80 transition-colors";
