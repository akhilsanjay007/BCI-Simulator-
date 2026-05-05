import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ManualIntent } from "./cursorPhysics";

/** Max rows shown in the UI raster (first N channels of the implant). */
const MAX_DISPLAY_CHANNELS = 64;
/** Time columns in the scrolling window (each column = one bin). */
const NUM_COLS = 96;
/** Simulated sampling bin width (ms) — drives scroll speed feel + firing rate scale. */
const BIN_MS = 22;
/** Target animation interval for simulation steps (~24 fps). */
const STEP_MS = 42;

/** Sparse baseline probability per bin at “rest” (Manual mode, no burst). */
const MANUAL_REST_P = 0.011;

const ACCENT = "#34d399";
const ACCENT_DIM = "rgba(52, 211, 153, 0.35)";
const BG = "#0a0a0a";
const GRID = "rgba(64, 64, 64, 0.45)";

export type ChartControlMode = "automatic" | "manual";

/** Partitions the first N displayed channels into four groups (motor directions). */
function intentBoostChannelIndices(intent: ManualIntent, numDisplayChannels: number): Set<number> {
  const cap = Math.max(0, Math.floor(numDisplayChannels));
  if (cap === 0) return new Set();
  const per = Math.max(1, Math.floor(cap / 4));
  const s = new Set<number>();
  const addRange = (start: number) => {
    for (let i = 0; i < per && start + i < cap; i++) s.add(start + i);
  };
  if (intent === "right") addRange(0);
  else if (intent === "left") addRange(per);
  else if (intent === "up") addRange(2 * per);
  else if (intent === "down") addRange(3 * per);
  return s;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export interface ManualNeuralBurstPayload {
  startMs: number;
  endMs: number;
  intent: ManualIntent;
}

interface NeuralSignalChartsProps {
  controlMode: ChartControlMode;
  /** Manual-only: cortical burst window from latest directional input. */
  manualBurst: ManualNeuralBurstPayload | null;
  /** Implant / decoder channel count (from WebSocket or default). */
  totalChannels: number;
  /** Tighter layout and shorter canvases for dashboard embedding (≤400px block height). */
  compact?: boolean;
}

function buildColumnAutomatic(nowSec: number, nCh: number): boolean[] {
  return Array.from({ length: nCh }, (_, ch) => {
    const r = Math.min(
      0.1,
      0.016 +
        0.045 * (0.5 + 0.5 * Math.sin(nowSec * 1.05 + ch * 0.37 + Math.sin(nowSec * 0.3))),
    );
    return Math.random() < r;
  });
}

function buildColumnManual(
  nowMs: number,
  burst: ManualNeuralBurstPayload | null,
  nCh: number,
): boolean[] {
  let envelope = 0;
  let boosted = new Set<number>();
  if (burst && nowMs < burst.endMs && burst.intent !== "rest") {
    const elapsed = nowMs - burst.startMs;
    const dur = Math.max(1, burst.endMs - burst.startMs);
    envelope = Math.max(0, Math.pow(1 - Math.min(1, elapsed / dur), 1.35));
    boosted = intentBoostChannelIndices(burst.intent, nCh);
  }

  return Array.from({ length: nCh }, (_, ch) => {
    let p =
      MANUAL_REST_P * (0.72 + 0.55 * Math.sin(nowMs / 9500 + ch * 0.73)) +
      0.002 * Math.sin(nowMs / 210 + ch);
    p = clamp(p, 0.004, 0.045);
    if (envelope > 0) {
      if (boosted.has(ch)) {
        p += envelope * 0.44;
      } else {
        p += envelope * 0.024;
      }
    }
    p = Math.min(0.88, p);
    return Math.random() < p;
  });
}

/**
 * Fallback raster height when the flex host has not been measured yet.
 * Dashboard compact mode targets ~9px/row for ≤36ch → readable 32-channel raster (~300px total).
 */
function computeRasterCanvasHeight(nCh: number, compact: boolean): number {
  const pad = 24;
  const minPlot = compact ? 200 : 72;
  if (!compact) {
    const maxTotal = 300;
    const pxPerRow = 2.75;
    const plot = Math.min(maxTotal - pad, Math.max(minPlot, nCh * pxPerRow));
    return Math.round(Math.min(maxTotal, pad + plot));
  }
  const pxPerRow = nCh <= 36 ? 9 : Math.max(4.5, Math.min(9, 320 / Math.max(1, nCh)));
  const plot = Math.min(326, Math.max(220, nCh * pxPerRow));
  return Math.round(Math.min(350, Math.max(280, pad + plot)));
}

/**
 * Educational demo: synthetic multi-channel spike trains + population firing rate.
 * Manual mode: sparse rest + short intent-aligned bursts. Automatic: original roaming rates.
 */
export function NeuralSignalCharts({
  controlMode,
  manualBurst,
  totalChannels,
  compact = false,
}: NeuralSignalChartsProps) {
  const total = Number.isFinite(totalChannels) && totalChannels >= 1 ? Math.floor(totalChannels) : 32;
  const displayCount = Math.min(MAX_DISPLAY_CHANNELS, Math.max(1, total));

  const wrapRef = useRef<HTMLDivElement>(null);
  /** Flex-sized viewport for the spike raster (dashboard fills this for max readability). */
  const rasterHostRef = useRef<HTMLDivElement>(null);
  const rasterRef = useRef<HTMLCanvasElement>(null);
  const rateRef = useRef<HTMLCanvasElement>(null);

  /** Columns left→right = past→present; each column is boolean[displayCount]. */
  const columnsRef = useRef<boolean[][]>([]);
  const lastStepRef = useRef(0);

  const propsRef = useRef({ controlMode, manualBurst, displayCount });
  useLayoutEffect(() => {
    propsRef.current = { controlMode, manualBurst, displayCount };
  }, [controlMode, manualBurst, displayCount]);

  const displayCountRef = useRef(displayCount);
  useLayoutEffect(() => {
    displayCountRef.current = displayCount;
  }, [displayCount]);

  const [tooltip, setTooltip] = useState<{
    clientX: number;
    clientY: number;
    channelIndex: number;
  } | null>(null);

  const initColumns = useCallback((nCh: number) => {
    const cols: boolean[][] = [];
    for (let i = 0; i < NUM_COLS; i++) {
      cols.push(Array.from({ length: nCh }, () => Math.random() < 0.025));
    }
    columnsRef.current = cols;
  }, []);

  useEffect(() => {
    initColumns(displayCount);
  }, [displayCount, initColumns]);

  const drawRaster = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number, nCh: number) => {
      const cols = columnsRef.current;
      const padL = 52;
      const padT = 10;
      const padB = 14;
      const plotW = w - padL - 8;
      const plotH = h - padT - padB;
      const rowH = plotH / Math.max(1, nCh);
      const colW = plotW / NUM_COLS;
      const tickHalf = Math.min(5, rowH * 0.35);

      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      for (let ch = 0; ch <= nCh; ch++) {
        const y = padT + ch * rowH;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
      }

      const labelStep =
        nCh <= 32 && rowH >= 5 ? 1 : Math.max(1, Math.ceil(nCh / 24));
      ctx.fillStyle = "rgba(115,115,115,0.85)";
      ctx.font = "10px ui-monospace, monospace";
      for (let ch = 0; ch < nCh; ch += labelStep) {
        const y = padT + ch * rowH + rowH / 2;
        ctx.fillText(`${ch + 1}`, 6, y + 3);
      }

      ctx.strokeStyle = ACCENT_DIM;
      ctx.lineWidth = 1;
      for (let t = 0; t < NUM_COLS; t += 12) {
        const x = padL + t * colW;
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();
      }

      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.25;
      for (let t = 0; t < NUM_COLS; t++) {
        const x = padL + t * colW + colW * 0.5;
        for (let ch = 0; ch < nCh; ch++) {
          if (!cols[t]?.[ch]) continue;
          const yMid = padT + ch * rowH + rowH * 0.5;
          ctx.beginPath();
          ctx.moveTo(x, yMid - tickHalf);
          ctx.lineTo(x, yMid + tickHalf);
          ctx.stroke();
        }
      }

      ctx.fillStyle = "rgba(163,163,163,0.9)";
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(
        `← past · ${((NUM_COLS * BIN_MS) / 1000).toFixed(1)} s · present →`,
        padL,
        h - 5,
      );
    },
    [],
  );

  const drawRate = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number, nCh: number) => {
    const cols = columnsRef.current;
    const padL = 52;
    const padR = 12;
    const padT = 10;
    const padB = 28;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const rates: number[] = [];
    for (let t = 0; t < NUM_COLS; t++) {
      let sum = 0;
      for (let ch = 0; ch < nCh; ch++) {
        if (cols[t]?.[ch]) sum += 1;
      }
      const hz = sum / Math.max(1, nCh) / (BIN_MS / 1000);
      rates.push(hz);
    }

    let peak = 8;
    for (const r of rates) peak = Math.max(peak, r * 1.15);

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      const hzLabel = (peak * (1 - i / 4)).toFixed(0);
      ctx.fillStyle = "rgba(115,115,115,0.9)";
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText(`${hzLabel} Hz`, 8, y + 3);
    }

    ctx.strokeStyle = ACCENT_DIM;
    ctx.beginPath();
    for (let t = 0; t < NUM_COLS; t++) {
      const x = padL + (t / (NUM_COLS - 1)) * plotW;
      const y = padT + plotH - (rates[t] / peak) * plotH;
      if (t === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const smooth: number[] = [];
    let ema = rates[0] ?? 0;
    const alpha = 0.18;
    for (let t = 0; t < NUM_COLS; t++) {
      ema = alpha * rates[t] + (1 - alpha) * ema;
      smooth.push(ema);
    }

    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let t = 0; t < NUM_COLS; t++) {
      const x = padL + (t / (NUM_COLS - 1)) * plotW;
      const y = padT + plotH - (smooth[t] / peak) * plotH;
      if (t === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = "rgba(163,163,163,0.9)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("Mean firing rate across channels (smoothed)", padL, h - 10);
  }, []);

  const resizeAndDraw = useCallback(() => {
    const wrap = wrapRef.current;
    const rEl = rasterRef.current;
    const rateEl = rateRef.current;
    if (!wrap || !rEl || !rateEl) return;

    const w = Math.max(320, wrap.clientWidth);
    const nCh = displayCountRef.current;
    const host = rasterHostRef.current;
    // Compact dashboard: raster canvas must exactly fill `rasterHostRef` or flex leaves a dead band
    // below the canvas (black void). Never cap below host height — draw scales with rowH = plotH/nCh.
    let rasterH = computeRasterCanvasHeight(nCh, compact);
    if (compact && host) {
      const h = Math.floor(host.clientHeight);
      if (h >= 80) {
        rasterH = h;
      }
    }
    const rateH = compact ? 84 : 120;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const setup = (canvas: HTMLCanvasElement, h: number) => {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return ctx;
    };

    const rCtx = setup(rEl, rasterH);
    const qCtx = setup(rateEl, rateH);
    if (rCtx) drawRaster(rCtx, w, rasterH, nCh);
    if (qCtx) drawRate(qCtx, w, rateH, nCh);
  }, [compact, drawRaster, drawRate]);

  useLayoutEffect(() => {
    resizeAndDraw();
  }, [compact, displayCount, resizeAndDraw]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const host = rasterHostRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => resizeAndDraw());
    ro.observe(wrap);
    if (host) ro.observe(host);
    return () => ro.disconnect();
  }, [resizeAndDraw]);

  useEffect(() => {
    let raf = 0;
    const step = (now: number) => {
      if (now - lastStepRef.current >= STEP_MS) {
        lastStepRef.current = now;
        const { controlMode: mode, manualBurst: burst, displayCount: n } = propsRef.current;
        const cols = columnsRef.current;
        const col =
          mode === "manual"
            ? buildColumnManual(Date.now(), burst, n)
            : buildColumnAutomatic(now / 1000, n);
        cols.push(col);
        cols.shift();

        resizeAndDraw();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [resizeAndDraw]);

  const onRasterMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = rasterRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const padL = 52;
    const padT = 10;
    const padB = 14;
    const nCh = displayCountRef.current;
    const plotH = rect.height - padT - padB;
    const rowH = plotH / Math.max(1, nCh);
    if (x < padL || x > rect.width - 8) {
      setTooltip(null);
      return;
    }
    const ch = clamp(Math.floor((y - padT) / rowH), 0, nCh - 1);
    setTooltip({
      clientX: e.clientX,
      clientY: e.clientY,
      channelIndex: ch,
    });
  };

  const onRasterLeave = () => setTooltip(null);

  const channelSummary = `Showing first ${displayCount} channels (out of ${total})`;

  return (
    <section
      className={`rounded-xl border border-neutral-800 bg-neutral-900/50 backdrop-blur-xl ${
        compact
          ? "p-2 flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden border-emerald-500/15 shadow-[0_0_32px_-12px_rgba(52,211,153,0.12)]"
          : "mt-10 rounded-3xl p-6 md:p-8"
      }`}
      aria-labelledby="raw-neural-signals-heading"
    >
      <div className={compact ? "mb-1 shrink-0" : "mb-6"}>
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2
            id="raw-neural-signals-heading"
            className={`font-semibold tracking-tight text-neutral-100 ${
              compact
                ? "text-[11px] uppercase tracking-[0.18em] text-emerald-400/95"
                : "text-xl mb-2"
            }`}
          >
            Raw Neural Signals
          </h2>
          {!compact && (
            <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-wider">
              {displayCount} ch · scroll
            </span>
          )}
        </div>
        {!compact && (
          <>
            <p className="text-sm text-neutral-400 leading-relaxed max-w-3xl space-y-1">
              <span className="block">Each line = one recording channel (electrode).</span>
              <span className="block">Vertical spikes = neural firing activity.</span>
            </p>
            <p className="mt-2 text-[11px] font-mono text-neutral-500">{channelSummary}</p>
            {controlMode === "manual" && (
              <p className="mt-3 text-xs text-amber-500/85 font-mono leading-relaxed max-w-3xl">
                Manual mode: low-rate “rest” baseline · each directional input triggers a ~300–600 ms burst on
                matching channel groups (like motor cortical patches), then fades back.
              </p>
            )}
          </>
        )}
        {compact && (
          <p className="text-[10px] text-neutral-500 font-mono truncate" title={channelSummary}>
            {channelSummary}
            <span className="text-neutral-600">
              {" "}
              · raster + rate{controlMode === "manual" ? " · manual overlay" : ""}
            </span>
          </p>
        )}
      </div>

      <div ref={wrapRef} className={compact ? "gap-1.5 min-h-0 flex-1 flex flex-col" : "space-y-6"}>
        <div className={compact ? "min-h-[280px] min-w-0 flex-1 flex flex-col" : ""}>
          {!compact && (
            <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
              <h3 className="text-sm font-medium text-neutral-300">Spike raster</h3>
              <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-wider">
                {displayCount} channels · scrolling
              </span>
            </div>
          )}
          <div
            ref={rasterHostRef}
            className={`relative rounded-lg border border-neutral-800/90 overflow-hidden bg-black ${
              compact ? "min-h-0 flex-1 w-full" : ""
            }`}
          >
            <canvas
              ref={rasterRef}
              className="block w-full cursor-crosshair touch-none align-top"
              onMouseMove={onRasterMove}
              onMouseLeave={onRasterLeave}
              aria-label="Spike raster plot: hover rows for channel info"
            />
          </div>
        </div>

        <div className={compact ? "min-h-0 shrink-0 pt-0.5" : ""}>
          <h3 className={`font-medium text-neutral-300 ${compact ? "text-[10px] mb-0.5 text-neutral-500" : "text-sm mb-2"}`}>
            Average firing rate
          </h3>
          <div className="relative rounded-lg border border-neutral-800 overflow-hidden bg-black">
            <canvas ref={rateRef} className="block w-full" aria-label="Mean firing rate across channels" />
          </div>
          {!compact && (
            <p className="mt-2 text-xs text-neutral-500 font-mono">
              Thin trace = instant rate · Bold = exponentially smoothed (easier to read).
            </p>
          )}
        </div>
      </div>

      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none max-w-[min(18rem,calc(100vw-2rem))] rounded-lg border border-emerald-500/35 bg-neutral-950/95 px-3 py-2 text-xs text-neutral-200 shadow-xl backdrop-blur-md"
          style={{
            left:
              typeof window !== "undefined"
                ? Math.min(tooltip.clientX + 14, window.innerWidth - 280)
                : tooltip.clientX + 14,
            top:
              typeof window !== "undefined"
                ? Math.min(tooltip.clientY + 14, window.innerHeight - 130)
                : tooltip.clientY + 14,
          }}
        >
          <p className="font-mono text-emerald-400/95 mb-1">
            Channel {tooltip.channelIndex + 1}
            {total > displayCount ? (
              <span className="text-neutral-500"> · trace {tooltip.channelIndex + 1} of {total} implanted</span>
            ) : null}
          </p>
          <p className="text-neutral-400 leading-snug">
            A <strong className="text-neutral-300 font-medium">channel</strong> is one electrode contact (or
            amplified trace). Each horizontal band shows spike times for that site; vertical ticks are individual
            spikes—brief bursts of neural firing.
          </p>
        </div>
      )}
    </section>
  );
}
