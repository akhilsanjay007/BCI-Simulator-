import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
const ACCENT_PEN = "rgba(110, 231, 183, 0.95)";
const VEL_LINE = "#38bdf8";
const VEL_LINE_DIM = "rgba(56, 189, 248, 0.45)";
const RAW_TRACE = "#f59e0b";
const RAW_TRACE_DIM = "rgba(245, 158, 11, 0.35)";
const BG = "#0a0a0a";
const GRID = "rgba(64, 64, 64, 0.45)";
const RAW_TRACE_SAMPLES = 320;
const RAW_INSERT_PER_STEP = 9;
const RAW_SNR_DB = 4.2;
/** Recent time window (ms) for stronger raster styling while control activity is present. */
const PEN_HIGHLIGHT_MS = 1700;
/** Speed threshold where movement should visibly count as active control. */
const MOVEMENT_ACTIVITY_THRESHOLD = 0.08;

export type ChartControlMode = "automatic" | "manual";
type MainChartView = "signals" | "activity";

/** Channels whose preferred direction (ring layout) aligns with ``(vx, vy)`` — matches backend coding. */
function velocityBoostChannelIndices(
  vx: number,
  vy: number,
  numDisplayChannels: number,
  ringChannels: number,
): Set<number> {
  const cap = Math.max(0, Math.floor(numDisplayChannels));
  const cRing = Math.max(2, Math.floor(ringChannels));
  const speed = Math.hypot(vx, vy);
  if (cap === 0 || speed < 1e-6) return new Set();
  const ux = vx / speed;
  const uy = vy / speed;
  const scored: { a: number; i: number }[] = [];
  for (let ch = 0; ch < cap; ch++) {
    const ang = (2 * Math.PI * ch) / cRing;
    const ax = Math.cos(ang);
    const ay = Math.sin(ang);
    const align = ax * ux + ay * uy;
    scored.push({ a: align, i: ch });
  }
  scored.sort((x, y) => y.a - x.a);
  const k = Math.max(4, Math.ceil(cap * 0.28));
  const s = new Set<number>();
  for (let j = 0; j < Math.min(k, scored.length); j++) {
    if (scored[j].a > 0.08) s.add(scored[j].i);
  }
  return s;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function createInitialRawVoltageBuffer(sampleCount: number): number[] {
  let slowNoise = 0;
  let phase = 0;
  return Array.from({ length: sampleCount }, () => {
    phase += 0.28;
    slowNoise = 0.95 * slowNoise + (Math.random() * 2 - 1) * 0.055;
    const oscillatory = 0.2 * Math.sin(phase) + 0.12 * Math.sin(phase * 2.8 + 0.7);
    const broadband = (Math.random() * 2 - 1) * 0.5;
    return clamp(oscillatory + slowNoise + broadband, -1.45, 1.45);
  });
}

export interface ManualNeuralBurstPayload {
  startMs: number;
  endMs: number;
  vx: number;
  vy: number;
}

interface NeuralSignalChartsProps {
  controlMode: ChartControlMode;
  /** Manual-only: cortical burst window from latest velocity command. */
  manualBurst: ManualNeuralBurstPayload | null;
  /** Implant / decoder channel count (from WebSocket or default). */
  totalChannels: number;
  /** Stylus / decoder contact — boosts recent raster + population activity. */
  penDown: boolean;
  /** Command velocity (manual pad or decoder), for movement trace. */
  vx: number;
  vy: number;
  /** Tighter layout and shorter canvases for dashboard embedding (≤400px block height). */
  compact?: boolean;
}

function buildColumnAutomatic(nowSec: number, nCh: number, penDown: boolean, speed: number): boolean[] {
  const drive = clamp(speed, 0, 1);
  return Array.from({ length: nCh }, (_, ch) => {
    let r = Math.min(
      0.14,
      0.016 +
        0.045 * (0.5 + 0.5 * Math.sin(nowSec * 1.05 + ch * 0.37 + Math.sin(nowSec * 0.3))) +
        0.06 * drive,
    );
    if (penDown) {
      r = Math.min(0.16, r + 0.055 + 0.02 * Math.sin(nowSec * 6 + ch * 0.2));
    }
    return Math.random() < r;
  });
}

function buildColumnManual(
  nowMs: number,
  burst: ManualNeuralBurstPayload | null,
  nCh: number,
  ringChannels: number,
  penDown: boolean,
  movementActive: boolean,
): boolean[] {
  let envelope = 0;
  let boosted = new Set<number>();
  const burstSpeed = burst ? Math.hypot(burst.vx, burst.vy) : 0;
  if (burst && nowMs < burst.endMs && burstSpeed > 1e-6) {
    const elapsed = nowMs - burst.startMs;
    const dur = Math.max(1, burst.endMs - burst.startMs);
    envelope = Math.max(0, Math.pow(1 - Math.min(1, elapsed / dur), 1.35));
    boosted = velocityBoostChannelIndices(burst.vx, burst.vy, nCh, ringChannels);
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
    if (penDown || movementActive) {
      p += 0.022 + (boosted.has(ch) ? 0.035 : 0.01) * (0.55 + 0.45 * Math.sin(nowMs / 140));
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
  const pxPerRow = nCh <= 36 ? 6.8 : Math.max(3.9, Math.min(6.8, 250 / Math.max(1, nCh)));
  const plot = Math.min(252, Math.max(178, nCh * pxPerRow));
  return Math.round(Math.min(286, Math.max(228, pad + plot)));
}

/**
 * Educational demo: synthetic multi-channel spike trains + population firing rate.
 * Manual mode: sparse rest + short velocity-aligned bursts. Automatic: original roaming rates.
 */
export function NeuralSignalCharts({
  controlMode,
  manualBurst,
  totalChannels,
  penDown,
  vx,
  vy,
  compact = false,
}: NeuralSignalChartsProps) {
  const total = Number.isFinite(totalChannels) && totalChannels >= 1 ? Math.floor(totalChannels) : 32;
  const displayCount = Math.min(MAX_DISPLAY_CHANNELS, Math.max(1, total));

  const wrapRef = useRef<HTMLDivElement>(null);
  /** Flex-sized viewport for the spike raster (dashboard fills this for max readability). */
  const rasterHostRef = useRef<HTMLDivElement>(null);
  const rateHostRef = useRef<HTMLDivElement>(null);
  const rawVoltageRef = useRef<HTMLCanvasElement>(null);
  const rasterRef = useRef<HTMLCanvasElement>(null);
  const rateRef = useRef<HTMLCanvasElement>(null);
  const rawTraceSeriesRef = useRef<number[]>(createInitialRawVoltageBuffer(RAW_TRACE_SAMPLES));
  const rawTracePhaseRef = useRef(0);
  const rawTraceNoiseRef = useRef(0);

  /** Columns left→right = past→present; each column is boolean[displayCount]. */
  const columnsRef = useRef<boolean[][]>([]);
  /** Per-column control activity (pen contact or movement, aligned with columnsRef indices). */
  const penByColRef = useRef<boolean[]>(Array.from({ length: NUM_COLS }, () => false));
  /** Per-column velocity magnitude |v| when the column was recorded. */
  const velByColRef = useRef<number[]>(Array.from({ length: NUM_COLS }, () => 0));
  const lastStepRef = useRef(0);

  const propsRef = useRef({
    controlMode,
    manualBurst,
    displayCount,
    totalChannels: total,
    penDown,
    vx,
    vy,
  });
  useLayoutEffect(() => {
    propsRef.current = {
      controlMode,
      manualBurst,
      displayCount,
      totalChannels: total,
      penDown,
      vx,
      vy,
    };
  }, [controlMode, manualBurst, displayCount, total, penDown, vx, vy]);

  const displayCountRef = useRef(displayCount);
  useLayoutEffect(() => {
    displayCountRef.current = displayCount;
  }, [displayCount]);

  const [tooltip, setTooltip] = useState<{
    clientX: number;
    clientY: number;
    channelIndex: number;
  } | null>(null);
  const [mainChartView, setMainChartView] = useState<MainChartView>("signals");

  useEffect(() => {
    if (mainChartView !== "signals") {
      setTooltip(null);
    }
  }, [mainChartView]);

  const initColumns = useCallback((nCh: number) => {
    const cols: boolean[][] = [];
    for (let i = 0; i < NUM_COLS; i++) {
      cols.push(Array.from({ length: nCh }, () => Math.random() < 0.025));
    }
    columnsRef.current = cols;
    penByColRef.current = Array.from({ length: NUM_COLS }, () => false);
    velByColRef.current = Array.from({ length: NUM_COLS }, () => 0);
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

      const activityHist = penByColRef.current;
      const highlightCols = Math.min(NUM_COLS, Math.max(1, Math.ceil(PEN_HIGHLIGHT_MS / BIN_MS)));
      for (let t = 0; t < NUM_COLS; t++) {
        const x = padL + t * colW + colW * 0.5;
        const recent = t >= NUM_COLS - highlightCols;
        const active = activityHist[t] === true;
        const emphasize = active && recent;
        const tick = emphasize ? Math.min(tickHalf * 1.45, rowH * 0.42) : tickHalf;
        ctx.strokeStyle = emphasize ? ACCENT_PEN : ACCENT;
        ctx.lineWidth = emphasize ? 2.1 : 1.25;
        ctx.globalAlpha = emphasize ? 1 : 0.92;
        for (let ch = 0; ch < nCh; ch++) {
          if (!cols[t]?.[ch]) continue;
          const yMid = padT + ch * rowH + rowH * 0.5;
          ctx.beginPath();
          ctx.moveTo(x, yMid - tick);
          ctx.lineTo(x, yMid + tick);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

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
    const velHist = velByColRef.current;
    const padL = 52;
    const padR = 12;
    const padT = 10;
    const padB = compact ? 38 : 36;
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

    const penLive = propsRef.current.penDown;
    const movementLive = Math.hypot(propsRef.current.vx, propsRef.current.vy) >= MOVEMENT_ACTIVITY_THRESHOLD;
    const activeLive = penLive || movementLive;
    const velAlpha = activeLive ? 0.52 : 0.28;
    const velSmooth: number[] = [];
    let ve = velHist[0] ?? 0;
    for (let t = 0; t < NUM_COLS; t++) {
      ve = velAlpha * (velHist[t] ?? 0) + (1 - velAlpha) * ve;
      velSmooth.push(ve);
    }

    /** Map |v| into same vertical space as population Hz (demo scale). */
    const VEL_TO_HZ = 11;
    const velAsHz = velSmooth.map((v) => v * VEL_TO_HZ);

    const smooth: number[] = [];
    let ema = rates[0] ?? 0;
    const rateAlpha = activeLive ? 0.32 : 0.18;
    for (let t = 0; t < NUM_COLS; t++) {
      ema = rateAlpha * rates[t] + (1 - rateAlpha) * ema;
      smooth.push(ema);
    }

    let peak = 7;
    for (const r of smooth) peak = Math.max(peak, r * 1.12);
    for (const v of velAsHz) peak = Math.max(peak, v * 1.08);
    peak = Math.max(peak, 4);

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

    ctx.strokeStyle = VEL_LINE_DIM;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (let t = 0; t < NUM_COLS; t++) {
      const x = padL + (t / (NUM_COLS - 1)) * plotW;
      const y = padT + plotH - (velAsHz[t] / peak) * plotH;
      if (t === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = VEL_LINE;
    ctx.lineWidth = activeLive ? 2.1 : 1.65;
    ctx.shadowColor = "rgba(56, 189, 248, 0.35)";
    ctx.shadowBlur = activeLive ? 8 : 4;
    ctx.beginPath();
    for (let t = 0; t < NUM_COLS; t++) {
      const x = padL + (t / (NUM_COLS - 1)) * plotW;
      const y = padT + plotH - (velAsHz[t] / peak) * plotH;
      if (t === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = activeLive ? 2.35 : 2;
    ctx.shadowColor = "rgba(52, 211, 153, 0.25)";
    ctx.shadowBlur = activeLive ? 6 : 3;
    ctx.beginPath();
    for (let t = 0; t < NUM_COLS; t++) {
      const x = padL + (t / (NUM_COLS - 1)) * plotW;
      const y = padT + plotH - (smooth[t] / peak) * plotH;
      if (t === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    const legY = h - (compact ? 10 : 12);
    const legX = padL;
    ctx.font = compact ? "8px ui-monospace, monospace" : "9px ui-monospace, monospace";
    ctx.fillStyle = ACCENT;
    ctx.fillRect(legX, legY - 6, 10, 3);
    ctx.fillStyle = "rgba(180, 190, 185, 0.92)";
    ctx.fillText(compact ? "Firing (Hz)" : "Mean firing (Hz · smoothed)", legX + 14, legY);

    const leg2 = legX + (compact ? 108 : 200);
    ctx.fillStyle = VEL_LINE;
    ctx.fillRect(leg2, legY - 6, 10, 3);
    ctx.fillStyle = "rgba(180, 200, 215, 0.92)";
    ctx.fillText(compact ? "|v| scaled" : "|v| movement (scaled)", leg2 + 14, legY);
  }, [compact]);

  const drawRawVoltage = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const trace = rawTraceSeriesRef.current;
    const padL = 16;
    const padR = 12;
    const padT = 10;
    const padB = 16;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const midY = padT + plotH * 0.5;
    const ampScale = plotH * 0.42;
    const n = trace.length;

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
    }
    ctx.strokeStyle = RAW_TRACE_DIM;
    ctx.beginPath();
    ctx.moveTo(padL, midY);
    ctx.lineTo(padL + plotW, midY);
    ctx.stroke();

    ctx.strokeStyle = RAW_TRACE;
    ctx.lineWidth = 1.6;
    ctx.shadowColor = "rgba(245, 158, 11, 0.35)";
    ctx.shadowBlur = 7;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = padL + (i / Math.max(1, n - 1)) * plotW;
      const y = midY - trace[i] * ampScale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.font = "9px ui-monospace, monospace";
    ctx.fillStyle = "rgba(163,163,163,0.9)";
    ctx.fillText("~1.6 s window", padL, h - 5);
  }, []);

  const appendRawVoltageSamples = useCallback((speed: number, controlActive: boolean) => {
    const trace = rawTraceSeriesRef.current;
    let phase = rawTracePhaseRef.current;
    let slowNoise = rawTraceNoiseRef.current;
    const speedDrive = clamp(speed, 0, 1.4);
    // Low-SNR synthetic neural trace: weak oscillatory signal + stronger broadband noise.
    for (let i = 0; i < RAW_INSERT_PER_STEP; i++) {
      phase += 0.3 + speedDrive * 0.05;
      slowNoise = 0.94 * slowNoise + (Math.random() * 2 - 1) * 0.058;
      const oscillatory =
        0.2 * Math.sin(phase + i * 0.07) +
        0.09 * Math.sin(phase * 2.7 + 0.9 + i * 0.05) +
        0.05 * Math.sin(phase * 6.1);
      const broadband = (Math.random() * 2 - 1) * (controlActive ? 0.58 : 0.5);
      trace.push(clamp(oscillatory + slowNoise + broadband, -1.45, 1.45));
    }
    if (trace.length > RAW_TRACE_SAMPLES) {
      trace.splice(0, trace.length - RAW_TRACE_SAMPLES);
    }
    rawTracePhaseRef.current = phase;
    rawTraceNoiseRef.current = slowNoise;
  }, []);

  const resizeAndDraw = useCallback(() => {
    const wrap = wrapRef.current;
    const rawEl = rawVoltageRef.current;
    const rEl = rasterRef.current;
    const rateEl = rateRef.current;
    if (!wrap || !rawEl) return;

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
    let rateH = compact ? 96 : 120;
    const rateHost = rateHostRef.current;
    if (compact && rateHost) {
      const hostH = Math.floor(rateHost.clientHeight);
      if (hostH >= 84) {
        rateH = hostH;
      }
    }
    const rawH = compact ? 112 : 120;
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

    const rawCtx = setup(rawEl, rawH);
    const rCtx = rEl ? setup(rEl, rasterH) : null;
    const qCtx = rateEl ? setup(rateEl, rateH) : null;
    if (rawCtx) drawRawVoltage(rawCtx, w, rawH);
    if (rCtx) drawRaster(rCtx, w, rasterH, nCh);
    if (qCtx) drawRate(qCtx, w, rateH, nCh);
  }, [compact, drawRaster, drawRate, drawRawVoltage]);

  useLayoutEffect(() => {
    resizeAndDraw();
  }, [compact, displayCount, resizeAndDraw]);

  useLayoutEffect(() => {
    resizeAndDraw();
  }, [mainChartView, resizeAndDraw]);

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
        const { controlMode: mode, manualBurst: burst, displayCount: n, totalChannels: t, penDown: pd, vx, vy } =
          propsRef.current;
        const cols = columnsRef.current;
        const speed = Math.hypot(vx, vy);
        const movementActive = speed >= MOVEMENT_ACTIVITY_THRESHOLD;
        const controlActive = pd || movementActive;
        appendRawVoltageSamples(speed, controlActive);
        const col =
          mode === "manual"
            ? buildColumnManual(Date.now(), burst, n, t, pd, movementActive)
            : buildColumnAutomatic(now / 1000, n, controlActive, speed);
        cols.push(col);
        cols.shift();
        penByColRef.current.push(controlActive);
        penByColRef.current.shift();
        velByColRef.current.push(Math.hypot(vx, vy));
        velByColRef.current.shift();

        resizeAndDraw();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [appendRawVoltageSamples, resizeAndDraw]);

  useLayoutEffect(() => {
    resizeAndDraw();
  }, [penDown, vx, vy, resizeAndDraw]);

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
          ? "p-1.5 flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden border-emerald-500/15 shadow-[0_0_32px_-12px_rgba(52,211,153,0.12)]"
          : "mt-10 rounded-3xl p-6 md:p-8"
      }`}
      aria-labelledby="raw-neural-signals-heading"
    >
      <div className={compact ? "mb-0.5 shrink-0" : "mb-6"}>
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
                Manual mode: low-rate “rest” baseline · each velocity command triggers a ~300–600 ms burst on
                ring-aligned channel subsets (population coding), then fades back.
              </p>
            )}
          </>
        )}
        {compact && (
          <p className="text-[10px] text-neutral-500 font-mono truncate" title={channelSummary}>
            {channelSummary}
            <span className="text-neutral-600">
              {" "}
              · raster + neural activity{controlMode === "manual" ? " · manual overlay" : ""}
            </span>
          </p>
        )}
      </div>

      <div ref={wrapRef} className={compact ? "gap-1 min-h-0 flex-1 flex flex-col" : "space-y-6"}>
        <div className={compact ? "shrink-0" : ""}>
          <div className="mb-1.5 flex items-baseline justify-between gap-3 flex-wrap">
            <h3
              className={`font-medium ${
                compact ? "text-[10px] uppercase tracking-wider text-amber-300/95" : "text-sm text-amber-300/95"
              }`}
            >
              Raw voltage trace (Noisy)
            </h3>
            <div className="flex items-center gap-2">
              {!compact && (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-amber-300/90">
                  Ch 7
                </span>
              )}
              <span className="text-[10px] font-mono uppercase tracking-wider text-amber-200/90">
                SNR: {RAW_SNR_DB.toFixed(1)} dB
              </span>
            </div>
          </div>
          <div className="relative rounded-lg border border-amber-500/25 overflow-hidden bg-black">
            <canvas
              ref={rawVoltageRef}
              className="block w-full h-[112px] sm:h-[120px]"
              aria-label="Raw continuous voltage trace with low signal-to-noise ratio"
            />
          </div>
          <p
            className={`font-mono text-neutral-500 ${
              compact ? "mt-0.5 text-[9px] tracking-[0.08em] truncate" : "mt-2 text-[10px] uppercase tracking-[0.14em]"
            }`}
            title="Raw Voltage → Spike Detection → Firing Rate"
          >
            Raw Voltage → Spike Detection → Firing Rate
          </p>
        </div>

        <div className={compact ? "shrink-0" : ""}>
          <div className="inline-flex w-full rounded-full border border-neutral-700/80 bg-neutral-950/55 p-0.5">
            <button
              type="button"
              onClick={() => setMainChartView("signals")}
              className={`flex-1 rounded-full px-2 py-0.5 text-[8px] font-mono font-semibold uppercase tracking-[0.1em] transition-colors ${
                mainChartView === "signals"
                  ? "border border-neutral-500/60 bg-neutral-800/85 text-neutral-100"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
              aria-pressed={mainChartView === "signals"}
            >
              RAW SIGNALS
            </button>
            <button
              type="button"
              onClick={() => setMainChartView("activity")}
              className={`flex-1 rounded-full px-2 py-0.5 text-[8px] font-mono font-semibold uppercase tracking-[0.1em] transition-colors ${
                mainChartView === "activity"
                  ? "border border-neutral-500/60 bg-neutral-800/85 text-neutral-100"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
              aria-pressed={mainChartView === "activity"}
            >
              ACTIVITY VS MOVEMENT
            </button>
          </div>
        </div>

        {mainChartView === "signals" ? (
          <div className={compact ? "min-h-0 min-w-0 flex-1 flex flex-col gap-1 transition-opacity duration-200" : "transition-opacity duration-200"}>
            {!compact && (
              <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
                <h3 className="text-sm font-medium text-neutral-300">Raw neural signals</h3>
                <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-wider">
                  {displayCount} channels · scrolling
                </span>
              </div>
            )}
            <div
              ref={rasterHostRef}
              className={`relative rounded-lg border border-neutral-800/90 overflow-hidden bg-black ${
                compact ? "min-h-[154px] min-w-0 flex-1 w-full" : ""
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
        ) : (
          <div className={compact ? "min-h-0 min-w-0 flex-1 flex flex-col transition-opacity duration-200" : "transition-opacity duration-200"}>
            <h3
              className={`font-medium text-neutral-300 ${
                compact ? "text-[10px] mb-0.5 text-neutral-400 uppercase tracking-wider" : "text-sm mb-2"
              }`}
            >
              Neural activity vs movement
            </h3>
            <div
              ref={rateHostRef}
              className={`relative rounded-lg border border-neutral-800 overflow-hidden bg-black ${
                compact ? "min-h-[154px] min-w-0 flex-1" : ""
              }`}
            >
              <canvas
                ref={rateRef}
                className="block w-full"
                aria-label="Neural activity and velocity magnitude"
              />
            </div>
            {!compact && (
              <p className="mt-2 text-xs text-neutral-500 font-mono">
                Emerald = population mean firing (smoothed). Cyan = command speed |v| on a matched scale while
                drawing.
              </p>
            )}
          </div>
        )}
      </div>

      {tooltip && mainChartView === "signals" && (
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
