import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import {
  stepCursorMotion,
  seedCursorMotion,
  type CursorMotionState,
  type ManualIntent,
} from "./cursorPhysics";
import { NeuralSignalCharts, type ManualNeuralBurstPayload } from "./NeuralSignalCharts";

function resolveBackendUrl(): string {
  const configured = (import.meta.env.VITE_BACKEND_URL as string | undefined)?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }

  if (import.meta.env.DEV) {
    return "http://localhost:8000";
  }

  throw new Error("VITE_BACKEND_URL must be set for production builds.");
}

function toWebSocketOrigin(httpOrigin: string): string {
  const url = new URL(httpOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

const BACKEND_HTTP_ORIGIN = resolveBackendUrl();
const BACKEND_WS_ORIGIN = toWebSocketOrigin(BACKEND_HTTP_ORIGIN);

const BACKEND_ENDPOINTS = {
  manualNeuralBurst: `${BACKEND_HTTP_ORIGIN}/manual-neural-burst`,
  simulatorConfig: `${BACKEND_HTTP_ORIGIN}/simulator/config`,
  decoderReset: `${BACKEND_HTTP_ORIGIN}/decoder/reset`,
  bciStreamWs: `${BACKEND_WS_ORIGIN}/ws/bci-stream`,
  decoderWs: `${BACKEND_WS_ORIGIN}/ws/decoder`,
} as const;

interface DecoderPacket {
  timestamp_ms: number;
  predicted_intent: "left" | "right" | "up" | "down" | "rest";
  confidence: number;
  latency_ms: number;
  /** Rolling accuracy, last 20 predictions */
  accuracy: number;
  /** Session accuracy since connect or last reset */
  session_accuracy: number;
  /** Normalized [0,1] from server-integrated 2D cursor */
  cursor_x?: number;
  cursor_y?: number;
  /** Implant / decoder channel count (simulator config) */
  num_channels?: number;
}

/** Interpolation between WebSocket samples (~20 ms); server applies velocity + EMA smoothing. */
const CURSOR_CSS_TRANSITION_MS = 280;

type ControlMode = "automatic" | "manual";

const DIR_ORDER: ManualIntent[] = ["left", "right", "up", "down"];

const KEY_TO_DIR: Record<string, ManualIntent> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

function pickHeldDirection(held: Set<ManualIntent>): ManualIntent {
  for (const d of DIR_ORDER) {
    if (held.has(d)) return d;
  }
  return "rest";
}

function formatSessionClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Random synaptic weight per discrete manual input (direction key / pad press). */
const SPIKE_CONFIDENCE_MIN = 0.75;
const SPIKE_CONFIDENCE_MAX = 0.99;
/** Exponential decay of the velocity boost envelope (1 → 0) after each spike. */
const SPIKE_PULSE_DECAY_PER_S = 5.4;

function sampleSpikeConfidence(): number {
  return SPIKE_CONFIDENCE_MIN + Math.random() * (SPIKE_CONFIDENCE_MAX - SPIKE_CONFIDENCE_MIN);
}

function App() {
  const [status, setStatus] = useState<"connected" | "disconnected">("disconnected");
  /** Total channels from decoder WebSocket (simulator/implant). */
  const [totalChannels, setTotalChannels] = useState(32);
  const [decoderData, setDecoderData] = useState<DecoderPacket | null>(null);
  const [cursorDisplay, setCursorDisplay] = useState({ x: 0.5, y: 0.5 });
  const [controlMode, setControlMode] = useState<ControlMode>("manual");
  const [manualIntentLabel, setManualIntentLabel] = useState<ManualIntent>("rest");
  /** Wall-clock session length for Manual metrics (seconds since load). */
  const [sessionElapsedSec, setSessionElapsedSec] = useState(0);
  /** Confidence sampled on the latest directional input (null after Rest / no spike yet). */
  const [latestSpikeCommandConfidence, setLatestSpikeCommandConfidence] = useState<number | null>(null);
  /** Instantaneous spike envelope × confidence for visuals (updated each animation frame). */
  const [spikeStrength, setSpikeStrength] = useState(0);
  /** Manual neural charts: cortical burst window aligned with directional input. */
  const [manualNeuralBurst, setManualNeuralBurst] = useState<ManualNeuralBurstPayload | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const controlModeRef = useRef<ControlMode>("manual");
  const cursorDisplayRef = useRef(cursorDisplay);
  const manualIntentRef = useRef<ManualIntent>("rest");
  const manualPhysicsRef = useRef<CursorMotionState>(seedCursorMotion(0.5, 0.5));
  /** Directions currently held via keyboard or on-screen buttons (not rest). */
  const manualDirectionsHeldRef = useRef<Set<ManualIntent>>(new Set());
  /** Confidence drawn for the current directional spike burst (drives physics + UI number). */
  const latestSpikeConfidenceRef = useRef<number | null>(null);
  /** 1 = fresh spike, decays toward 0 — multiplies confidence for a brief velocity boost. */
  const spikePulseEnvelopeRef = useRef(0);

  useLayoutEffect(() => {
    controlModeRef.current = controlMode;
    cursorDisplayRef.current = cursorDisplay;
  }, [controlMode, cursorDisplay]);

  const syncManualIntentFromHeld = useCallback(() => {
    const intent = pickHeldDirection(manualDirectionsHeldRef.current);
    manualIntentRef.current = intent;
    setManualIntentLabel(intent);
  }, []);

  const fireManualDirectionSpike = useCallback((intentDir: ManualIntent) => {
    const c = sampleSpikeConfidence();
    latestSpikeConfidenceRef.current = c;
    spikePulseEnvelopeRef.current = 1;
    setLatestSpikeCommandConfidence(c);
    const duration = 300 + Math.random() * 300;
    const start = Date.now();
    setManualNeuralBurst({ startMs: start, endMs: start + duration, intent: intentDir });
    void fetch(BACKEND_ENDPOINTS.manualNeuralBurst, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: intentDir, duration_ms: duration }),
    }).catch(() => {});
  }, []);

  const applyManualDirectionDown = useCallback(
    (dir: ManualIntent) => {
      if (dir === "rest") return;
      fireManualDirectionSpike(dir);
      manualDirectionsHeldRef.current.add(dir);
      syncManualIntentFromHeld();
    },
    [syncManualIntentFromHeld, fireManualDirectionSpike],
  );

  const applyManualDirectionUp = useCallback(
    (dir: ManualIntent) => {
      if (dir === "rest") return;
      manualDirectionsHeldRef.current.delete(dir);
      syncManualIntentFromHeld();
    },
    [syncManualIntentFromHeld],
  );

  const applyManualRest = useCallback(() => {
    manualDirectionsHeldRef.current.clear();
    manualIntentRef.current = "rest";
    setManualIntentLabel("rest");
    latestSpikeConfidenceRef.current = null;
    spikePulseEnvelopeRef.current = 0;
    setLatestSpikeCommandConfidence(null);
    setSpikeStrength(0);
    setManualNeuralBurst(null);
  }, []);

  /**
   * Switches control mode and updates the ref synchronously so WebSocket handlers
   * cannot apply decoder cursor/metrics in the gap before React re-renders.
   */
  const selectControlMode = useCallback((mode: ControlMode) => {
    controlModeRef.current = mode;
    setControlMode(mode);
    if (mode === "manual") {
      setDecoderData(null);
      latestSpikeConfidenceRef.current = null;
      spikePulseEnvelopeRef.current = 0;
      setLatestSpikeCommandConfidence(null);
      setSpikeStrength(0);
    }
    setManualNeuralBurst(null);
  }, []);

  // Match simulator channel count before / between WebSocket frames (same source as `num_channels` in packets).
  useEffect(() => {
    void fetch(BACKEND_ENDPOINTS.simulatorConfig)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { num_channels?: number } | null) => {
        if (j && typeof j.num_channels === "number" && j.num_channels >= 1) {
          setTotalChannels(Math.floor(j.num_channels));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const ws = new WebSocket(BACKEND_ENDPOINTS.decoderWs);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      console.log("✅ Connected to BCI Decoder");
    };

    ws.onmessage = (event) => {
      try {
        const data: DecoderPacket = JSON.parse(event.data);
        if (typeof data.num_channels === "number" && data.num_channels >= 1) {
          setTotalChannels(Math.floor(data.num_channels));
        }
        // Apply decoder packets only in Automatic mode so Manual stays free of model metrics/state.
        if (controlModeRef.current !== "automatic") {
          return;
        }
        setDecoderData(data);
        setCursorDisplay({
          x: data.cursor_x ?? 0.5,
          y: data.cursor_y ?? 0.5,
        });
      } catch (error) {
        console.error("Error parsing decoder data:", error);
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
      console.log("❌ Disconnected from BCI Decoder");
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      setStatus("disconnected");
    };

    return () => {
      ws.close();
    };
  }, []);

  // Session clock for Manual metrics panel (elapsed since page load).
  useEffect(() => {
    const id = window.setInterval(() => {
      setSessionElapsedSec((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // When entering Manual mode, seed local physics from the current cursor so motion stays continuous.
  useEffect(() => {
    if (controlMode === "manual") {
      const { x, y } = cursorDisplayRef.current;
      manualPhysicsRef.current = seedCursorMotion(x, y);
    }
  }, [controlMode]);

  // Manual mode: same velocity + EMA integration as the decoder, stepped each animation frame.
  useEffect(() => {
    if (controlMode !== "manual") return;

    let frameId = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.064);
      last = now;

      spikePulseEnvelopeRef.current *= Math.exp(-SPIKE_PULSE_DECAY_PER_S * dt);
      if (spikePulseEnvelopeRef.current < 0.004) {
        spikePulseEnvelopeRef.current = 0;
      }

      const intent = manualIntentRef.current;
      let effectiveConfidence = 0;
      if (intent !== "rest" && latestSpikeConfidenceRef.current != null) {
        effectiveConfidence = latestSpikeConfidenceRef.current * spikePulseEnvelopeRef.current;
      }

      manualPhysicsRef.current = stepCursorMotion(
        manualPhysicsRef.current,
        intent,
        effectiveConfidence,
        dt,
      );
      const { xSmooth, ySmooth } = manualPhysicsRef.current;
      setCursorDisplay({ x: xSmooth, y: ySmooth });

      let strengthVisual = 0;
      if (intent !== "rest" && latestSpikeConfidenceRef.current != null) {
        strengthVisual = latestSpikeConfidenceRef.current * spikePulseEnvelopeRef.current;
      }
      setSpikeStrength(strengthVisual);

      frameId = requestAnimationFrame(loop);
    };

    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [controlMode]);

  // Keyboard: arrows + Space (rest). Only active in Manual mode.
  useEffect(() => {
    if (controlMode !== "manual") return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        applyManualRest();
        return;
      }
      const dir = KEY_TO_DIR[e.key];
      if (!dir) return;
      e.preventDefault();
      if (e.repeat) return;
      applyManualDirectionDown(dir);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const dir = KEY_TO_DIR[e.key];
      if (!dir) return;
      e.preventDefault();
      applyManualDirectionUp(dir);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [controlMode, applyManualDirectionDown, applyManualDirectionUp, applyManualRest]);

  const resetDecoderState = async () => {
    try {
      await fetch(BACKEND_ENDPOINTS.decoderReset, { method: "POST" });
      if (controlMode === "automatic") {
        setCursorDisplay({ x: 0.5, y: 0.5 });
      } else {
        manualPhysicsRef.current = seedCursorMotion(0.5, 0.5);
        setCursorDisplay({ x: 0.5, y: 0.5 });
      }
    } catch (e) {
      console.error("Decoder reset failed:", e);
    }
  };

  const getIntentColor = (intent: string) => {
    switch (intent) {
      case "left":
        return "text-blue-400";
      case "right":
        return "text-red-400";
      case "up":
        return "text-green-400";
      case "down":
        return "text-yellow-400";
      case "rest":
        return "text-cyan-400/90";
      default:
        return "text-neutral-400";
    }
  };

  const showCursor = controlMode === "manual" || decoderData !== null;

  const footerIntent =
    controlMode === "automatic"
      ? decoderData?.predicted_intent
        ? `${decoderData.predicted_intent.toUpperCase()} (${(decoderData.confidence * 100).toFixed(0)}%)`
        : "—"
      : manualIntentLabel && manualIntentLabel !== "rest"
        ? `${manualIntentLabel.toUpperCase()} · synth`
        : "REST";

  const footerLatency =
    controlMode === "automatic" && decoderData ? `${decoderData.latency_ms.toFixed(1)} ms` : "—";

  return (
    <div className="h-screen min-h-0 flex flex-col overflow-hidden bg-neuralink-bg text-neuralink-text">
      {/* 1. Top bar */}
      <header className="shrink-0 flex items-center justify-between gap-3 px-3 py-2 border-b border-neutral-800/90 bg-black/50 backdrop-blur-sm">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 shrink-0 bg-neuralink-accent rounded-full flex items-center justify-center text-black font-bold text-lg">
            N
          </div>
          <div className="min-w-0">
            <h1 className="text-sm sm:text-base font-semibold tracking-tight text-neutral-100 truncate">
              Neuralink BCI
            </h1>
            <p className="text-[10px] text-neutral-500 font-mono uppercase tracking-wider">Dashboard</p>
          </div>
        </div>

        <div
          className="flex items-center gap-1 rounded-full border border-neutral-700/80 bg-black/70 p-0.5"
          role="tablist"
          aria-label="Control mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={controlMode === "automatic"}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
              controlMode === "automatic"
                ? "bg-neuralink-accent text-black shadow-[0_0_16px_rgba(0,255,170,0.25)]"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
            onClick={() => selectControlMode("automatic")}
          >
            Automatic
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={controlMode === "manual"}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
              controlMode === "manual"
                ? "bg-neuralink-accent text-black shadow-[0_0_16px_rgba(0,255,170,0.25)]"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
            onClick={() => selectControlMode("manual")}
          >
            Manual
          </button>
        </div>

        <div
          className={`shrink-0 flex items-center gap-2 px-2.5 py-1 rounded-md text-[11px] font-mono font-medium border ${
            status === "connected"
              ? "border-emerald-500/35 text-emerald-400 bg-emerald-500/5"
              : "border-red-500/35 text-red-400 bg-red-500/5"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              status === "connected" ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" : "bg-red-400"
            }`}
          />
          {status === "connected" ? "Connected" : "Disconnected"}
        </div>
      </header>

      {/* 2. Main: cursor (hero) | controls + neural signals (raster is second visual priority) */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-2 p-2">
        {/* LEFT — cursor (primary) */}
        <section className="flex-[7] min-h-0 min-w-0 flex flex-col rounded-xl border border-neutral-800 bg-neutral-900/60 px-2 pt-2 pb-2">
          <div className="flex items-center justify-between gap-2 mb-1.5 shrink-0">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Cursor</h2>
            <span
              className={`text-[10px] font-mono uppercase tracking-wider rounded px-2 py-0.5 border ${
                controlMode === "manual"
                  ? "text-amber-300 border-amber-500/30 bg-amber-950/40"
                  : "text-emerald-300 border-emerald-500/30 bg-emerald-950/40"
              }`}
            >
              {controlMode === "manual" ? "Manual" : "Decoder"}
            </span>
          </div>
          <div className="flex-1 min-h-[12rem] bg-black rounded-lg border border-neutral-800/90 relative overflow-hidden">
            <div
              className="absolute inset-0 opacity-[0.22] pointer-events-none"
              style={{
                backgroundImage: `
                  linear-gradient(to right, rgb(55 55 55) 1px, transparent 1px),
                  linear-gradient(to bottom, rgb(55 55 55) 1px, transparent 1px)
                `,
                backgroundSize: "32px 32px",
              }}
            />
            <div
              className="absolute left-1/2 top-1/2 w-1.5 h-1.5 -ml-[3px] -mt-[3px] rounded-full bg-neutral-500 ring-1 ring-neutral-700"
              aria-hidden
            />
            {showCursor && (
              <div
                className="absolute w-3.5 h-3.5 rounded-full bg-neuralink-accent shadow-[0_0_18px_rgba(0,255,170,0.5)] border border-white/90 z-10 will-change-[left,top]"
                style={{
                  left: `${cursorDisplay.x * 100}%`,
                  top: `${cursorDisplay.y * 100}%`,
                  transform: "translate(-50%, -50%)",
                  transition: `left ${CURSOR_CSS_TRANSITION_MS}ms cubic-bezier(0.25, 0.06, 0.22, 1), top ${CURSOR_CSS_TRANSITION_MS}ms cubic-bezier(0.25, 0.06, 0.22, 1)`,
                }}
                title={
                  controlMode === "manual"
                    ? "Manual cursor (client physics, matches decoder smoothing)"
                    : "Decoded cursor (velocity-smoothed from server)"
                }
              />
            )}
            {!showCursor && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <p className="text-neutral-500 font-mono text-center text-xs">Waiting for decoder stream…</p>
              </div>
            )}
          </div>
        </section>

        {/* RIGHT — compact command / decoder strip + neural signals (dominant) */}
        <aside className="flex-[5] min-h-0 min-w-0 flex flex-col gap-1.5 overflow-hidden">
          <div className="shrink-0 rounded-lg border border-neutral-800/90 bg-neutral-900/50 px-2 py-1.5">
            {controlMode === "manual" ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[9px] font-mono font-semibold uppercase tracking-[0.18em] text-amber-400/95">
                    Manual
                  </p>
                  <span className="text-[8px] font-mono text-amber-950 bg-amber-400/90 px-1 py-px rounded">
                    Live
                  </span>
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 items-center">
                  <div
                    className={`text-2xl font-bold leading-none tracking-tight ${
                      manualIntentLabel ? getIntentColor(manualIntentLabel) : "text-neutral-500"
                    }`}
                  >
                    {manualIntentLabel ? manualIntentLabel.toUpperCase() : "—"}
                  </div>
                  <div className="text-[9px] font-mono text-right text-neutral-400 space-y-0.5">
                    <div>
                      <span className="text-neutral-600">conf </span>
                      <span className="text-amber-100 tabular-nums">
                        {latestSpikeCommandConfidence != null ? latestSpikeCommandConfidence.toFixed(2) : "—"}
                      </span>
                    </div>
                    <div>
                      <span className="text-neutral-600">str </span>
                      <span className="text-amber-200 tabular-nums">{(spikeStrength * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                </div>
                <div
                  className="h-1 rounded-sm bg-neutral-950 border border-amber-900/40 overflow-hidden"
                  title="Spike envelope × confidence"
                >
                  <div
                    className="h-full rounded-sm bg-gradient-to-r from-amber-700 via-amber-400 to-amber-200 transition-[width] duration-75"
                    style={{ width: `${Math.min(100, spikeStrength * 100)}%` }}
                  />
                </div>
                <div className="grid grid-cols-4 gap-1 text-[9px] font-mono">
                  <div className="col-span-2 rounded border border-amber-900/25 px-1.5 py-0.5 text-neutral-400">
                    Sess <span className="text-amber-100 tabular-nums">{formatSessionClock(sessionElapsedSec)}</span>
                  </div>
                  <div className="rounded border border-amber-900/25 px-1.5 py-0.5 text-neutral-400 truncate">
                    X <span className="text-neutral-200 tabular-nums">{cursorDisplay.x.toFixed(3)}</span>
                  </div>
                  <div className="rounded border border-amber-900/25 px-1.5 py-0.5 text-neutral-400 truncate">
                    Y <span className="text-neutral-200 tabular-nums">{cursorDisplay.y.toFixed(3)}</span>
                  </div>
                </div>
                <div className="select-none">
                  <div className="flex flex-col items-center gap-0.5">
                    <ManualPadButton
                      label="Up"
                      compact
                      onDown={() => applyManualDirectionDown("up")}
                      onUp={() => applyManualDirectionUp("up")}
                    />
                    <div className="flex gap-0.5">
                      <ManualPadButton
                        label="L"
                        compact
                        onDown={() => applyManualDirectionDown("left")}
                        onUp={() => applyManualDirectionUp("left")}
                      />
                      <ManualPadButton label="RST" isRest compact onDown={applyManualRest} onUp={() => {}} />
                      <ManualPadButton
                        label="R"
                        compact
                        onDown={() => applyManualDirectionDown("right")}
                        onUp={() => applyManualDirectionUp("right")}
                      />
                    </div>
                    <ManualPadButton
                      label="Dn"
                      compact
                      onDown={() => applyManualDirectionDown("down")}
                      onUp={() => applyManualDirectionUp("down")}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[9px] font-mono font-semibold uppercase tracking-[0.18em] text-emerald-400/95">
                    Decoder
                  </span>
                  <span className="text-[8px] font-mono px-1 py-px rounded border border-emerald-500/35 text-emerald-300/95 bg-emerald-950/50">
                    Live
                  </span>
                </div>
                <div className="grid grid-cols-[1fr_1fr] gap-x-2 items-start">
                  <div
                    className={`text-2xl font-bold leading-none tracking-tight ${
                      decoderData?.predicted_intent
                        ? getIntentColor(decoderData.predicted_intent)
                        : "text-neutral-500"
                    }`}
                  >
                    {decoderData?.predicted_intent ? decoderData.predicted_intent.toUpperCase() : "—"}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono leading-tight">
                    <div className="flex justify-between gap-1 col-span-2 border-b border-white/[0.05] pb-0.5">
                      <dt className="text-neutral-500">Conf</dt>
                      <dd className="text-neutral-100 tabular-nums">
                        {decoderData ? `${(decoderData.confidence * 100).toFixed(0)}%` : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-1">
                      <dt className="text-neutral-500">Lat</dt>
                      <dd className="text-emerald-400 tabular-nums">
                        {decoderData ? `${decoderData.latency_ms.toFixed(0)}` : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-1">
                      <dt className="text-neutral-500">A20</dt>
                      <dd className="text-emerald-400/95 tabular-nums">
                        {decoderData ? `${(decoderData.accuracy * 100).toFixed(0)}` : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-1 col-span-2">
                      <dt className="text-neutral-500">Asess</dt>
                      <dd className="text-emerald-300/95 tabular-nums">
                        {decoderData ? `${(decoderData.session_accuracy * 100).toFixed(1)}%` : "—"}
                      </dd>
                    </div>
                  </dl>
                </div>
                <button
                  type="button"
                  onClick={resetDecoderState}
                  className="w-full py-1 rounded border border-neutral-600 text-neutral-300 text-[9px] font-medium hover:bg-neutral-800/80 transition-colors"
                >
                  Reset
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 min-h-0 flex flex-col overflow-hidden rounded-lg border border-emerald-900/20 bg-black/20">
            <NeuralSignalCharts
              controlMode={controlMode}
              manualBurst={manualNeuralBurst}
              totalChannels={totalChannels}
              compact
            />
          </div>
        </aside>
      </div>

      {/* 3. Bottom bar */}
      <footer className="shrink-0 border-t border-neutral-800/90 bg-black/40 px-3 py-1">
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-0.5 text-[10px] font-mono text-neutral-500">
          <span>
            <span className="text-neutral-600">Intent distribution</span>{" "}
            <span className="text-neutral-300">{footerIntent}</span>
          </span>
          <span className="text-neutral-700 hidden sm:inline" aria-hidden>
            ·
          </span>
          <span>
            <span className="text-neutral-600">Latency</span>{" "}
            <span className="text-neutral-300">{footerLatency}</span>
          </span>
          <span className="text-neutral-700 hidden sm:inline" aria-hidden>
            ·
          </span>
          <span>
            <span className="text-neutral-600">Session time</span>{" "}
            <span className="text-neutral-300 tabular-nums">{formatSessionClock(sessionElapsedSec)}</span>
          </span>
        </div>
      </footer>
    </div>
  );
}

/** Large touch-friendly pad button with pointer capture for reliable hold/release. */
function ManualPadButton(props: {
  label: string;
  isRest?: boolean;
  compact?: boolean;
  onDown: () => void;
  onUp: () => void;
}) {
  const { label, isRest, compact, onDown, onUp } = props;

  return (
    <button
      type="button"
      className={`rounded-lg border font-semibold tracking-wide transition-colors active:scale-[0.98] ${
        compact
          ? "min-w-[4.25rem] min-h-[2.35rem] px-2.5 text-xs"
          : "min-w-[5.5rem] min-h-[3.25rem] px-4 text-sm"
      } ${
        isRest
          ? "border-cyan-500/40 bg-cyan-950/40 text-cyan-200 hover:bg-cyan-900/50"
          : "border-neutral-600 bg-neutral-800/80 text-neutral-100 hover:bg-neutral-700/90 hover:border-neutral-500"
      }`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onDown();
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        onUp();
      }}
      onPointerCancel={() => {
        onUp();
      }}
      onPointerLeave={(e) => {
        if (e.buttons === 0) onUp();
      }}
    >
      {label}
    </button>
  );
}

export default App;
