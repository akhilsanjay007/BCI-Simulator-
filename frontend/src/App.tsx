import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import {
  stepCursorMotion,
  seedCursorMotion,
  MANUAL_CONTROL_CONFIDENCE,
  type CursorMotionState,
} from "./cursorPhysics";
import {
  BCITrackpad,
  idleManualTrackpadDrive,
  type BCITrackpadHandle,
  type ManualTrackpadDrive,
} from "./BCITrackpad";
import { NeuralSignalCharts, type ManualNeuralBurstPayload } from "./NeuralSignalCharts";
import {
  computeInstantSignalQuality,
  signalTierFromPct,
  signalTierStyles,
  stepSignalSmooth,
  type SignalQualityInput,
} from "./signalQuality";

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
  decoderMode: `${BACKEND_HTTP_ORIGIN}/decoder/mode`,
  decoderWs: `${BACKEND_WS_ORIGIN}/ws/decoder`,
} as const;

/** Shown in the current-letter slot before any recognition this session. */
const CURRENT_LETTER_IDLE = "—";
/** Hint when the accumulated sentence is empty. */
const FULL_TEXT_PLACEHOLDER = "Your sentence builds here, letter by letter…";

interface DecoderPacket {
  timestamp_ms: number;
  vx: number;
  vy: number;
  pen_down: boolean;
  confidence: number;
  mode: "cursor" | "handwriting";
  latency_ms: number;
  accuracy: number;
  session_accuracy: number;
  cursor_x?: number;
  cursor_y?: number;
  num_channels?: number;
}

interface DecoderResetEvent {
  type: "decoder_reset";
  timestamp_ms: number;
  cursor_x: number;
  cursor_y: number;
  num_channels: number;
}

function isDecoderResetEvent(data: unknown): data is DecoderResetEvent {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: string }).type === "decoder_reset"
  );
}

function formatDecoderVelocity(vx: number, vy: number): string {
  const mag = Math.hypot(vx, vy);
  return `vx ${vx >= 0 ? "+" : ""}${vx.toFixed(2)} · vy ${vy >= 0 ? "+" : ""}${vy.toFixed(2)} · |v| ${mag.toFixed(2)}`;
}

function velocityHueClass(vx: number, vy: number): string {
  const mag = Math.hypot(vx, vy);
  if (mag < 0.06) return "text-cyan-400/90";
  const ang = (Math.atan2(vy, vx) * 180) / Math.PI;
  if (ang >= -45 && ang < 45) return "text-red-400";
  if (ang >= 45 && ang < 135) return "text-yellow-400";
  if (ang >= -135 && ang < -45) return "text-green-400";
  return "text-blue-400";
}

type ControlMode = "automatic" | "manual";

type DirectionKey = "left" | "right" | "up" | "down";

const KEY_TO_DIR: Record<string, DirectionKey> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

function netVelocityFromHeld(held: Set<DirectionKey>): { vx: number; vy: number } {
  let vx = 0;
  let vy = 0;
  if (held.has("left")) vx -= 1;
  if (held.has("right")) vx += 1;
  if (held.has("up")) vy -= 1;
  if (held.has("down")) vy += 1;
  const n = Math.hypot(vx, vy);
  if (n < 1e-6) return { vx: 0, vy: 0 };
  return { vx: vx / n, vy: vy / n };
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

const SPIKE_CONFIDENCE_MIN = 0.75;
const SPIKE_CONFIDENCE_MAX = 0.99;
const SPIKE_PULSE_DECAY_PER_S = 5.4;

function sampleSpikeConfidence(): number {
  return SPIKE_CONFIDENCE_MIN + Math.random() * (SPIKE_CONFIDENCE_MAX - SPIKE_CONFIDENCE_MIN);
}

function App() {
  const [status, setStatus] = useState<"connected" | "disconnected">("disconnected");
  const [totalChannels, setTotalChannels] = useState(32);
  const [decoderData, setDecoderData] = useState<DecoderPacket | null>(null);
  const [cursorDisplay, setCursorDisplay] = useState({ x: 0.5, y: 0.5 });
  const [controlMode, setControlMode] = useState<ControlMode>("manual");
  const [manualVelocityLabel, setManualVelocityLabel] = useState("rest");
  const [manualCmd, setManualCmd] = useState({ vx: 0, vy: 0 });
  const [sessionElapsedSec, setSessionElapsedSec] = useState(0);
  const [latestSpikeCommandConfidence, setLatestSpikeCommandConfidence] = useState<number | null>(
    null,
  );
  const [spikeStrength, setSpikeStrength] = useState(0);
  const [manualNeuralBurst, setManualNeuralBurst] = useState<ManualNeuralBurstPayload | null>(null);
  const [manualPenDown, setManualPenDown] = useState(false);
  const [currentLetter, setCurrentLetter] = useState<string | null>(null);
  const [fullText, setFullText] = useState("");
  const [recognizeError, setRecognizeError] = useState<string | null>(null);
  const [signalPct, setSignalPct] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const trackpadRef = useRef<BCITrackpadHandle | null>(null);
  const controlModeRef = useRef<ControlMode>("manual");
  const cursorDisplayRef = useRef(cursorDisplay);
  const decoderDataRef = useRef<DecoderPacket | null>(null);
  const manualPenDownRef = useRef(false);
  const manualVelocityRef = useRef({ vx: 0, vy: 0 });
  const manualPhysicsRef = useRef<CursorMotionState>(seedCursorMotion(0.5, 0.5));
  const manualDirectionsHeldRef = useRef<Set<DirectionKey>>(new Set());
  const manualTrackpadDriveRef = useRef<ManualTrackpadDrive>(idleManualTrackpadDrive());
  const lastManualPadSpeedRef = useRef(0);
  const lastSpikeFireAtRef = useRef(0);
  const latestSpikeConfidenceRef = useRef<number | null>(null);
  const spikePulseEnvelopeRef = useRef(0);
  const signalSmoothRef = useRef(0);
  const penUpSinceRef = useRef(performance.now());
  const spikeStrengthRef = useRef(0);

  useLayoutEffect(() => {
    controlModeRef.current = controlMode;
    cursorDisplayRef.current = cursorDisplay;
    decoderDataRef.current = decoderData;
    manualPenDownRef.current = manualPenDown;
    spikeStrengthRef.current = spikeStrength;
  }, [controlMode, cursorDisplay, decoderData, manualPenDown, spikeStrength]);

  const handleRecognizeLetter = useCallback((letter: string) => {
    setRecognizeError(null);
    setCurrentLetter(letter);
    setFullText((prev) => prev + letter);
  }, []);

  const handleRecognizeError = useCallback((message: string) => {
    setRecognizeError(message);
  }, []);

  const handleCanvasCleared = useCallback(() => {
    setCurrentLetter(null);
    setRecognizeError(null);
  }, []);

  const handleClearText = useCallback(() => {
    setFullText("");
  }, []);

  const syncManualVelocityFromHeld = useCallback(() => {
    const v = netVelocityFromHeld(manualDirectionsHeldRef.current);
    manualVelocityRef.current = v;
    const n = Math.hypot(v.vx, v.vy);
    setManualCmd(v);
    setManualVelocityLabel(n < 1e-6 ? "rest" : formatDecoderVelocity(v.vx, v.vy));
  }, []);

  const fireManualVelocitySpike = useCallback((vx: number, vy: number) => {
    const c = sampleSpikeConfidence();
    latestSpikeConfidenceRef.current = c;
    spikePulseEnvelopeRef.current = 1;
    setLatestSpikeCommandConfidence(c);
    const duration = 300 + Math.random() * 300;
    const start = Date.now();
    setManualNeuralBurst({ startMs: start, endMs: start + duration, vx, vy });
    void fetch(BACKEND_ENDPOINTS.manualNeuralBurst, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vx, vy, duration_ms: duration }),
    }).catch(() => {});
  }, []);

  const applyManualDirectionDown = useCallback(
    (dir: DirectionKey) => {
      manualDirectionsHeldRef.current.add(dir);
      syncManualVelocityFromHeld();
      const v = netVelocityFromHeld(manualDirectionsHeldRef.current);
      if (Math.hypot(v.vx, v.vy) > 1e-6) {
        fireManualVelocitySpike(v.vx, v.vy);
      }
    },
    [syncManualVelocityFromHeld, fireManualVelocitySpike],
  );

  const applyManualDirectionUp = useCallback(
    (dir: DirectionKey) => {
      manualDirectionsHeldRef.current.delete(dir);
      syncManualVelocityFromHeld();
    },
    [syncManualVelocityFromHeld],
  );

  const applyManualRest = useCallback(() => {
    manualDirectionsHeldRef.current.clear();
    manualVelocityRef.current = { vx: 0, vy: 0 };
    manualTrackpadDriveRef.current = idleManualTrackpadDrive();
    setManualCmd({ vx: 0, vy: 0 });
    setManualVelocityLabel("rest");
    setManualPenDown(false);
    latestSpikeConfidenceRef.current = null;
    spikePulseEnvelopeRef.current = 0;
    setLatestSpikeCommandConfidence(null);
    setSpikeStrength(0);
    setManualNeuralBurst(null);
    lastManualPadSpeedRef.current = 0;
  }, []);

  const absorbManualTrackpadFrame = useCallback(
    (pad: ManualTrackpadDrive, now: number) => {
      if (!pad.active) {
        manualVelocityRef.current = { vx: 0, vy: 0 };
        setManualCmd({ vx: 0, vy: 0 });
        setManualPenDown(false);
        setManualVelocityLabel("rest");
        lastManualPadSpeedRef.current = 0;
        return;
      }

      manualVelocityRef.current = { vx: pad.vx, vy: pad.vy };
      setManualCmd({ vx: pad.vx, vy: pad.vy });
      setManualPenDown(pad.penDown);

      const n = Math.hypot(pad.vx, pad.vy);
      setManualVelocityLabel(n < 1e-6 ? "rest" : formatDecoderVelocity(pad.vx, pad.vy));

      manualPhysicsRef.current = {
        ...manualPhysicsRef.current,
        xRaw: pad.nx,
        yRaw: pad.ny,
        xSmooth: pad.nx,
        ySmooth: pad.ny,
      };
      setCursorDisplay({ x: pad.nx, y: pad.ny });

      const crossed = n > 0.14 && lastManualPadSpeedRef.current <= 0.14;
      const cooled = now - lastSpikeFireAtRef.current > 420;
      if (n > 0.14 && (crossed || cooled)) {
        fireManualVelocitySpike(pad.vx, pad.vy);
        lastSpikeFireAtRef.current = now;
      }
      lastManualPadSpeedRef.current = n;
    },
    [fireManualVelocitySpike],
  );

  const applyDecoderReset = useCallback(
    (event: DecoderResetEvent) => {
      const cx = event.cursor_x ?? 0.5;
      const cy = event.cursor_y ?? 0.5;
      if (typeof event.num_channels === "number" && event.num_channels >= 1) {
        setTotalChannels(Math.floor(event.num_channels));
      }
      setDecoderData(null);
      manualPhysicsRef.current = seedCursorMotion(cx, cy);
      setCursorDisplay({ x: cx, y: cy });
      applyManualRest();
      manualTrackpadDriveRef.current = idleManualTrackpadDrive();
      trackpadRef.current?.clearCanvas();
      setCurrentLetter(null);
      setFullText("");
      setRecognizeError(null);
      signalSmoothRef.current = 0;
      setSignalPct(0);
      penUpSinceRef.current = performance.now();
    },
    [applyManualRest],
  );

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

  useEffect(() => {
    void fetch(BACKEND_ENDPOINTS.decoderMode, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "handwriting" }),
    }).catch(() => {});
  }, []);

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
        const raw: unknown = JSON.parse(event.data);
        if (isDecoderResetEvent(raw)) {
          applyDecoderReset(raw);
          return;
        }
        const data = raw as DecoderPacket;
        if (typeof data.num_channels === "number" && data.num_channels >= 1) {
          setTotalChannels(Math.floor(data.num_channels));
        }
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
  }, [applyDecoderReset]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setSessionElapsedSec((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (controlMode === "manual") {
      const { x, y } = cursorDisplayRef.current;
      manualPhysicsRef.current = seedCursorMotion(x, y);
    }
  }, [controlMode]);

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

      const pad = manualTrackpadDriveRef.current;
      const keysHeld = manualDirectionsHeldRef.current.size > 0;

      if (pad.active) {
        absorbManualTrackpadFrame(pad, now);
      } else if (keysHeld) {
        const { vx: cmdVx, vy: cmdVy } = manualVelocityRef.current;
        let effectiveConfidence = 0;
        if (Math.hypot(cmdVx, cmdVy) > 1e-6 && latestSpikeConfidenceRef.current != null) {
          effectiveConfidence = latestSpikeConfidenceRef.current * spikePulseEnvelopeRef.current;
        }

        manualPhysicsRef.current = stepCursorMotion(
          manualPhysicsRef.current,
          cmdVx,
          cmdVy,
          effectiveConfidence,
          dt,
        );
        const { xSmooth, ySmooth } = manualPhysicsRef.current;
        setCursorDisplay({ x: xSmooth, y: ySmooth });

        let strengthVisual = 0;
        if (Math.hypot(cmdVx, cmdVy) > 1e-6 && latestSpikeConfidenceRef.current != null) {
          strengthVisual = latestSpikeConfidenceRef.current * spikePulseEnvelopeRef.current;
        }
        setSpikeStrength(strengthVisual);
      } else {
        manualVelocityRef.current = { vx: 0, vy: 0 };
        setSpikeStrength(0);
      }

      frameId = requestAnimationFrame(loop);
    };

    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [controlMode, absorbManualTrackpadFrame]);

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

  const metricsPenDown =
    controlMode === "manual" ? manualPenDown : (decoderData?.pen_down ?? false);

  useEffect(() => {
    if (!metricsPenDown) {
      penUpSinceRef.current = performance.now();
    }
  }, [metricsPenDown]);

  useEffect(() => {
    let frameId = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.064);
      last = now;

      const mode = controlModeRef.current;
      const penDown =
        mode === "manual" ? manualPenDownRef.current : (decoderDataRef.current?.pen_down ?? false);
      const penUpIdleSec = penDown ? 0 : (now - penUpSinceRef.current) / 1000;

      let confidence = 0;
      let velocityMag = 0;
      let spike = 0;

      if (mode === "manual") {
        const pad = manualTrackpadDriveRef.current;
        const cmd = manualVelocityRef.current;
        velocityMag = pad.active ? Math.hypot(pad.vx, pad.vy) : Math.hypot(cmd.vx, cmd.vy);
        confidence =
          latestSpikeConfidenceRef.current != null
            ? latestSpikeConfidenceRef.current
            : MANUAL_CONTROL_CONFIDENCE;
        spike = spikeStrengthRef.current;
      } else {
        const pkt = decoderDataRef.current;
        velocityMag = pkt ? Math.hypot(pkt.vx, pkt.vy) : 0;
        confidence = pkt?.confidence ?? 0;
        spike = 0;
      }

      const input: SignalQualityInput = {
        confidence,
        penDown,
        velocityMag,
        spikeStrength: spike,
        penUpIdleSec,
      };
      const target = computeInstantSignalQuality(input);
      signalSmoothRef.current = stepSignalSmooth(signalSmoothRef.current, target, dt);
      setSignalPct(Math.round(signalSmoothRef.current * 100));

      frameId = requestAnimationFrame(loop);
    };

    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, []);

  const resetDecoderState = async () => {
    try {
      await fetch(BACKEND_ENDPOINTS.decoderReset, { method: "POST" });
      applyDecoderReset({
        type: "decoder_reset",
        timestamp_ms: Date.now(),
        cursor_x: 0.5,
        cursor_y: 0.5,
        num_channels: totalChannels,
      });
    } catch (e) {
      console.error("[App] Decoder reset failed:", e);
    }
  };

  const handleClearCanvas = () => {
    trackpadRef.current?.clearCanvas();
    manualTrackpadDriveRef.current = idleManualTrackpadDrive();
    applyManualRest();
  };

  const handleRecognize = () => {
    trackpadRef.current?.recognize();
  };

  const manualDriving =
    controlMode === "manual" &&
    (manualPenDown || manualTrackpadDriveRef.current.active);
  const metricsVx = manualDriving ? manualCmd.vx : (decoderData?.vx ?? 0);
  const metricsVy = manualDriving ? manualCmd.vy : (decoderData?.vy ?? 0);
  const metricsMoving = Math.hypot(metricsVx, metricsVy) > 1e-6;

  const signalTier = signalTierFromPct(signalPct);
  const signalStyle = signalTierStyles(signalTier);

  const isComposing =
    controlMode === "manual"
      ? manualPenDown
      : (decoderData?.pen_down ?? false);

  const displayConfidence =
    controlMode === "manual"
      ? latestSpikeCommandConfidence != null
        ? latestSpikeCommandConfidence
        : MANUAL_CONTROL_CONFIDENCE
      : (decoderData?.confidence ?? 0);

  const velocityLabel =
    controlMode === "manual"
      ? manualVelocityLabel
      : decoderData
        ? formatDecoderVelocity(decoderData.vx, decoderData.vy)
        : "—";

  return (
    <div className="h-screen min-h-0 flex flex-col overflow-hidden bg-neuralink-bg text-neuralink-text">
      <header className="shrink-0 flex items-center justify-between gap-3 px-4 py-2.5 border-b border-neutral-800/90 bg-black/60 backdrop-blur-md">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 shrink-0 rounded-full bg-neuralink-accent flex items-center justify-center text-black font-bold text-lg shadow-[0_0_24px_rgba(0,255,159,0.35)]">
            N
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-sm sm:text-base font-semibold tracking-tight text-neutral-100 truncate">
              Neuralink BCI
            </h1>
            <p className="text-[10px] text-neutral-500 font-mono uppercase tracking-[0.2em]">
              Implant dashboard
            </p>
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
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              controlMode === "automatic"
                ? "bg-neuralink-accent text-black shadow-[0_0_20px_rgba(0,255,170,0.3)]"
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
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              controlMode === "manual"
                ? "bg-neuralink-accent text-black shadow-[0_0_20px_rgba(0,255,170,0.3)]"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
            onClick={() => selectControlMode("manual")}
          >
            Manual
          </button>
        </div>

        <div
          className={`shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-mono font-medium border ${
            status === "connected"
              ? "border-emerald-500/40 text-emerald-300 bg-emerald-500/10"
              : "border-red-500/35 text-red-400 bg-red-500/5"
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              status === "connected"
                ? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.85)] animate-bci-pulse"
                : "bg-red-400"
            }`}
          />
          {status === "connected" ? "Live" : "Offline"}
        </div>
      </header>

      <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.2fr)_minmax(0,0.85fr)] gap-2 p-2 overflow-hidden">
        {/* LEFT — decoder metrics + neural charts */}
        <aside className="order-2 lg:order-1 min-h-0 min-w-0 flex flex-col gap-2 overflow-hidden">
          <section className="shrink-0 rounded-xl border border-neutral-800/90 bg-gradient-to-b from-neutral-900/70 to-black/50 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h2 className="text-[10px] font-mono font-semibold uppercase tracking-[0.2em] text-neutral-400">
                Decoder metrics
              </h2>
              <span
                className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-px rounded border ${
                  controlMode === "manual"
                    ? "text-amber-300 border-amber-500/35 bg-amber-950/40"
                    : "text-emerald-300 border-emerald-500/35 bg-emerald-950/40"
                }`}
              >
                {controlMode === "manual" ? "Manual" : "Decoder"}
              </span>
            </div>

            <div className="space-y-2">
              <p
                className={`text-sm font-bold font-mono leading-snug tracking-tight ${
                  metricsMoving ? velocityHueClass(metricsVx, metricsVy) : "text-cyan-400/90"
                }`}
              >
                {controlMode === "manual"
                  ? manualVelocityLabel !== "rest"
                    ? manualVelocityLabel
                    : "REST"
                  : velocityLabel}
              </p>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] font-mono">
                <div className="flex justify-between gap-1 col-span-2 border-b border-white/[0.06] pb-1">
                  <dt className="text-neutral-500">Confidence</dt>
                  <dd className="text-neutral-100 tabular-nums">{(displayConfidence * 100).toFixed(0)}%</dd>
                </div>
                <div className="flex justify-between gap-1">
                  <dt className="text-neutral-500">Latency</dt>
                  <dd className="text-emerald-400 tabular-nums">
                    {controlMode === "automatic" && decoderData
                      ? `${decoderData.latency_ms.toFixed(0)} ms`
                      : "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-1">
                  <dt className="text-neutral-500">Pen</dt>
                  <dd className="text-neutral-200 tabular-nums">{metricsPenDown ? "down" : "up"}</dd>
                </div>
                {controlMode === "automatic" && decoderData ? (
                  <>
                    <div className="flex justify-between gap-1">
                      <dt className="text-neutral-500">A20</dt>
                      <dd className="text-emerald-400/95 tabular-nums">
                        {(decoderData.accuracy * 100).toFixed(0)}%
                      </dd>
                    </div>
                    <div className="flex justify-between gap-1">
                      <dt className="text-neutral-500">Session</dt>
                      <dd className="text-emerald-300/95 tabular-nums">
                        {(decoderData.session_accuracy * 100).toFixed(1)}%
                      </dd>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex justify-between gap-1">
                      <dt className="text-neutral-500">Spike</dt>
                      <dd className="text-amber-200 tabular-nums">{(spikeStrength * 100).toFixed(0)}%</dd>
                    </div>
                    <div className="flex justify-between gap-1">
                      <dt className="text-neutral-500">Sess</dt>
                      <dd className="text-amber-100 tabular-nums">{formatSessionClock(sessionElapsedSec)}</dd>
                    </div>
                  </>
                )}
              </dl>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-[9px] font-mono uppercase tracking-wider text-neutral-500">
                    Signal
                  </span>
                  <span className={`text-[10px] font-mono font-semibold tabular-nums ${signalStyle.text}`}>
                    {signalPct}%
                  </span>
                </div>
                <div
                  className={`h-1.5 rounded-full bg-neutral-950 border overflow-hidden ${signalStyle.border}`}
                  title="Smoothed neural signal quality"
                >
                  <div
                    className={`h-full rounded-full bg-gradient-to-r transition-[width] duration-75 ${signalStyle.bar}`}
                    style={{ width: `${signalPct}%` }}
                  />
                </div>
                <p className="mt-1 text-[9px] font-mono text-neutral-600 flex items-center gap-1.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${signalStyle.dot}`} />
                  {signalTier === "good" ? "Strong coupling" : signalTier === "medium" ? "Moderate" : "Weak"}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-1 text-[9px] font-mono text-neutral-500">
                <div className="rounded border border-neutral-800/80 px-1.5 py-0.5">
                  X <span className="text-neutral-200 tabular-nums">{cursorDisplay.x.toFixed(3)}</span>
                </div>
                <div className="rounded border border-neutral-800/80 px-1.5 py-0.5">
                  Y <span className="text-neutral-200 tabular-nums">{cursorDisplay.y.toFixed(3)}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => void resetDecoderState()}
                className="w-full py-1.5 rounded-lg border border-neutral-600/80 text-neutral-300 text-[10px] font-medium hover:bg-neutral-800/80 transition-colors"
              >
                Reset decoder
              </button>
            </div>
          </section>

          <div className="flex-1 min-h-0 flex flex-col overflow-hidden rounded-xl border border-emerald-900/25 bg-black/30">
            <NeuralSignalCharts
              controlMode={controlMode}
              manualBurst={manualNeuralBurst}
              totalChannels={totalChannels}
              penDown={metricsPenDown}
              vx={metricsVx}
              vy={metricsVy}
              compact
            />
          </div>
        </aside>

        {/* CENTER — square handwriting canvas */}
        <section className="order-1 lg:order-2 min-h-0 min-w-0 flex flex-col items-center justify-center gap-2 overflow-hidden">
          <div className="w-full max-w-full flex flex-col items-center shrink-0">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-neutral-500 mb-1.5 self-start">
              Handwriting canvas
            </p>
            <div
              className="relative w-full aspect-square max-w-full"
              style={{ maxHeight: "min(100%, calc(100vh - 11rem))" }}
            >
              <BCITrackpad
                ref={trackpadRef}
                className="absolute inset-0"
                controlMode={controlMode}
                cursorNorm={cursorDisplay}
                vx={controlMode === "manual" ? manualCmd.vx : (decoderData?.vx ?? 0)}
                vy={controlMode === "manual" ? manualCmd.vy : (decoderData?.vy ?? 0)}
                penDown={metricsPenDown}
                manualDriveRef={manualTrackpadDriveRef}
                onRecognizeLetter={handleRecognizeLetter}
                onRecognizeError={handleRecognizeError}
                onCanvasCleared={handleCanvasCleared}
              />
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2 mt-3 w-full">
              <button
                type="button"
                onClick={handleClearCanvas}
                className="px-4 py-2 rounded-lg border border-red-500/40 bg-red-950/30 text-red-200 text-xs font-semibold hover:bg-red-950/50 transition-colors"
              >
                Clear canvas
              </button>
              <button
                type="button"
                onClick={handleRecognize}
                className="px-4 py-2 rounded-lg border border-emerald-500/45 bg-emerald-950/40 text-emerald-200 text-xs font-semibold hover:bg-emerald-900/50 shadow-[0_0_20px_-8px_rgba(52,211,153,0.5)] transition-colors"
              >
                Recognize
              </button>
            </div>

            <p className="mt-2 text-[10px] font-mono text-neutral-500 text-center leading-relaxed max-w-md">
              Hover to move the stylus · click-drag to ink · Space = rest · arrow keys still steer in Manual
            </p>
            {controlMode === "automatic" && !decoderData && (
              <p className="text-[10px] font-mono text-amber-500/80 mt-1">Waiting for decoder stream…</p>
            )}
          </div>
        </section>

        {/* RIGHT — thought-to-text output */}
        <aside className="order-3 min-h-0 min-w-0 flex flex-col gap-2 overflow-hidden">
          <section className="flex-1 min-h-0 flex flex-col rounded-xl border border-neutral-800/90 bg-gradient-to-b from-neutral-900/60 to-black/50 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-center justify-between gap-2 shrink-0 mb-3">
              <h2 className="font-display text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-400/75">
                Thought → Text
              </h2>
              {isComposing ? (
                <span className="text-[9px] font-mono font-medium text-emerald-400/95 uppercase tracking-wider animate-bci-pulse">
                  Live
                </span>
              ) : (
                <span className="text-[9px] font-mono text-neutral-600 uppercase tracking-wider">Standby</span>
              )}
            </div>

            <div className="shrink-0 mb-3">
              <p className="text-[9px] font-mono font-semibold uppercase tracking-[0.18em] text-neutral-500 mb-1.5">
                Current Letter
              </p>
              <div className={`relative rounded-lg border overflow-hidden flex items-center justify-center min-h-[4.5rem] px-3 py-2 ${
                  recognizeError
                    ? "border-amber-500/40 bg-amber-950/20"
                    : "border-emerald-400/30 bg-emerald-950/20 shadow-[0_0_24px_-12px_rgba(52,211,153,0.35),inset_0_1px_0_rgba(255,255,255,0.05)]"
                }`}>
                <div className="absolute inset-0 bg-gradient-to-b from-emerald-500/[0.05] to-transparent pointer-events-none" />
                <p
                  className={`relative font-display font-bold tabular-nums leading-none select-none ${
                    currentLetter != null
                      ? "text-5xl sm:text-6xl text-emerald-50 tracking-tight"
                      : "text-4xl text-neutral-600"
                  } ${currentLetter === " " ? "underline decoration-emerald-400/50 decoration-2 underline-offset-[10px]" : ""}`}
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {currentLetter ?? CURRENT_LETTER_IDLE}
                </p>
              </div>
              {recognizeError ? (
                <p className="mt-1.5 text-[9px] font-mono text-amber-400/90 leading-snug">{recognizeError}</p>
              ) : null}
            </div>

            <div className="flex-1 min-h-0 flex flex-col">
              <p className="text-[9px] font-mono font-semibold uppercase tracking-[0.18em] text-neutral-500 mb-1.5 shrink-0">
                Full Text
              </p>
              <div className="relative flex-1 min-h-[7rem] rounded-lg border border-emerald-400/25 bg-black/40 overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/[0.03] via-transparent to-transparent pointer-events-none" />
                <div className="relative h-full overflow-y-auto px-3 py-3">
                  <p
                    className={`font-display text-lg sm:text-xl font-medium leading-relaxed tracking-tight break-words whitespace-pre-wrap ${
                      fullText.length === 0 ? "text-neutral-600 italic text-base" : "text-neutral-100"
                    }`}
                    aria-live="polite"
                  >
                    {fullText.length === 0 ? FULL_TEXT_PLACEHOLDER : fullText}
                    {isComposing && fullText.length > 0 ? (
                      <span
                        className="inline-block w-[2px] h-[0.9em] ml-0.5 align-middle rounded-sm bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)] animate-bci-caret"
                        aria-hidden
                      />
                    ) : null}
                  </p>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleClearText}
              disabled={fullText.length === 0}
              className="mt-3 w-full shrink-0 rounded-lg border border-neutral-600/70 bg-neutral-950/80 px-3 py-2 text-xs font-semibold text-neutral-300 transition-colors hover:border-neutral-500 hover:bg-neutral-900/90 disabled:opacity-40 disabled:pointer-events-none"
            >
              Clear Text
            </button>
          </section>
        </aside>
      </main>
    </div>
  );
}

export default App;
