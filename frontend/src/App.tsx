import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import {
  stepCursorMotion,
  seedCursorMotion,
  type CursorMotionState,
} from "./utils/cursorPhysics";
import { BCITrackpad, type BCITrackpadHandle } from "./components/BCITrackpad";
import { idleManualTrackpadDrive, type ManualTrackpadDrive } from "./utils/manualTrackpad";
import { NeuralSignalCharts, type ManualNeuralBurstPayload } from "./components/NeuralSignalCharts";
import { DecoderMetrics } from "./components/DecoderMetrics";
import { ThoughtToText } from "./components/ThoughtToText";
import {
  computeInstantSignalQuality,
  signalTierStyles,
  stepSignalSmooth,
  type SignalQualityInput,
} from "./utils/signalQuality";
import {
  applyWordSuggestion,
  getWordSuggestions,
  predictSwipeWords,
} from "./utils/wordSuggestions";

function normalizeBackendUrl(value: string | undefined | null): string | null {
  const normalized = (value ?? "").trim().replace(/\/$/, "");
  return normalized.length > 0 ? normalized : null;
}

function resolveBackendUrl(): string {
  const runtimeConfigured = normalizeBackendUrl(window.__APP_CONFIG__?.VITE_BACKEND_URL);
  if (runtimeConfigured) {
    return runtimeConfigured;
  }

  const buildConfigured = normalizeBackendUrl(import.meta.env.VITE_BACKEND_URL);
  if (buildConfigured) {
    return buildConfigured;
  }

  if (import.meta.env.DEV) {
    return "http://localhost:8000";
  }

  // Fallback for same-origin deployments when a runtime env var is not set.
  return window.location.origin.replace(/\/$/, "");
}

function toWebSocketOrigin(httpOrigin: string): string {
  const url = new URL(httpOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

const BACKEND_HTTP_ORIGIN = resolveBackendUrl();
const BACKEND_WS_ORIGIN = toWebSocketOrigin(BACKEND_HTTP_ORIGIN);

const BACKEND_ENDPOINTS = {
  manualDecoderPredict: `${BACKEND_HTTP_ORIGIN}/manual-decoder-predict`,
  simulatorConfig: `${BACKEND_HTTP_ORIGIN}/simulator/config`,
  healthRedis: `${BACKEND_HTTP_ORIGIN}/health/redis`,
  decoderInfo: `${BACKEND_HTTP_ORIGIN}/api/decoder/info`,
  recordings: `${BACKEND_HTTP_ORIGIN}/api/recordings`,
  selectRecording: `${BACKEND_HTTP_ORIGIN}/api/recordings/select`,
  playback: `${BACKEND_HTTP_ORIGIN}/api/recordings/playback`,
  decoderReset: `${BACKEND_HTTP_ORIGIN}/decoder/reset`,
  decoderWs: `${BACKEND_WS_ORIGIN}/ws/decoder`,
} as const;

interface RecordingOption {
  recording_id: string;
  label: string;
  recording_file: string;
}

interface RecordingsResponse {
  recordings?: RecordingOption[];
  selected_recording_id?: string | null;
}

interface PlaybackStatusResponse {
  paused?: boolean;
  progress?: number;
  duration_ms?: number;
  speed?: number;
  replay_active?: boolean;
  replay_loaded?: boolean;
  recording_file?: string | null;
}

interface RedisHealthResponse {
  status?: "ok" | "error" | "disabled" | string;
  stream?: string;
}

interface DecoderInfoResponse {
  is_trained?: boolean;
  model_type?: string;
  regressor?: string;
}

/** Hint when the accumulated sentence is empty. */
const FULL_TEXT_PLACEHOLDER = "Type with the BCI cursor on the keyboard…";

interface DecoderPacket {
  timestamp_ms: number;
  vx: number;
  vy: number;
  pen_down: boolean;
  confidence: number;
  decode_latency_ms: number;
  end_to_end_latency_ms: number;
  redis_buffer_seconds: number;
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

interface ReplayLatencyStats {
  meanEmitIntervalMs: number;
  p95EmitIntervalMs: number;
  meanSourceLagMs: number;
  p95SourceLagMs: number;
}

function isDecoderResetEvent(data: unknown): data is DecoderResetEvent {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: string }).type === "decoder_reset"
  );
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

const SPIKE_CONFIDENCE_MIN = 0.75;
const SPIKE_CONFIDENCE_MAX = 0.99;
const SPIKE_PULSE_DECAY_PER_S = 5.4;
const AUTO_CURSOR_SMOOTH_PER_S = 24;
const AUTO_CURSOR_DEADZONE_NORM = 0.0008;
const AUTO_CURSOR_VELOCITY_BOOST_MAX = 0.85;
const AUTO_TARGET_SMOOTH_PER_S = 36;
const AUTO_TARGET_DEADZONE_NORM = 0.0012;
const AUTO_TARGET_JUMP_SNAP_NORM = 0.16;
const AUTO_REPLAY_SMOOTH_BOOST = 1.2;
const AUTO_REPLAY_DEADZONE_SCALE = 0.55;
const SIGNAL_DISPLAY_GAIN = 1.15;
const SIGNAL_DISPLAY_BIAS = 0.06;
const FETCH_TIMEOUT_MS = 5000;
const REPLAY_STATS_WINDOW = 180;
const MANUAL_DECODE_MIN_INTERVAL_MS = 20;

function sampleSpikeConfidence(): number {
  return SPIKE_CONFIDENCE_MIN + Math.random() * (SPIKE_CONFIDENCE_MAX - SPIKE_CONFIDENCE_MIN);
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function summarizeWindow(samples: number[]): { mean: number; p95: number } {
  if (samples.length === 0) {
    return { mean: 0, p95: 0 };
  }
  const mean = samples.reduce((acc, value) => acc + value, 0) / samples.length;
  const sorted = [...samples].sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1));
  return { mean, p95: sorted[p95Index] };
}

function App() {
  const [status, setStatus] = useState<"connected" | "disconnected">("disconnected");
  const [redisStatus, setRedisStatus] = useState<"checking" | "ok" | "error" | "disabled">("checking");
  const [redisStream, setRedisStream] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<"checking" | "ready" | "fallback" | "error">(
    "checking",
  );
  const [modelLabel, setModelLabel] = useState<string>("Unknown model");
  const [totalChannels, setTotalChannels] = useState(32);
  const [decoderData, setDecoderData] = useState<DecoderPacket | null>(null);
  const [cursorDisplay, setCursorDisplay] = useState({ x: 0.5, y: 0.5 });
  const [controlMode, setControlMode] = useState<ControlMode>("automatic");
  const [manualCmd, setManualCmd] = useState({ vx: 0, vy: 0 });
  const [spikeStrength, setSpikeStrength] = useState(0);
  const [manualNeuralBurst, setManualNeuralBurst] = useState<ManualNeuralBurstPayload | null>(null);
  const [manualPenDown, setManualPenDown] = useState(false);
  const [manualTrackpadActive, setManualTrackpadActive] = useState(false);
  const [fullText, setFullText] = useState("");
  /** Non-empty while a finished swipe is awaiting a chip selection. */
  const [swipeSuggestions, setSwipeSuggestions] = useState<string[]>([]);
  const [signalPct, setSignalPct] = useState(0);
  /** Pointer over the full Thought → Text panel (hover = decode intent). */
  const [thoughtPanelIntent, setThoughtPanelIntent] = useState(false);
  const [recordings, setRecordings] = useState<RecordingOption[]>([]);
  const [selectedRecordingFile, setSelectedRecordingFile] = useState<string | null>(null);
  const [replayLoaded, setReplayLoaded] = useState(false);
  const [replayPaused, setReplayPaused] = useState(true);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayLatencyStats, setReplayLatencyStats] = useState<ReplayLatencyStats | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const trackpadRef = useRef<BCITrackpadHandle | null>(null);
  const thoughtPanelRef = useRef<HTMLElement | null>(null);
  const thoughtPanelIntentRef = useRef(false);
  const controlModeRef = useRef<ControlMode>("automatic");
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
  const penUpSinceRef = useRef(0);
  const spikeStrengthRef = useRef(0);
  const autoCursorTargetRef = useRef({ x: 0.5, y: 0.5 });
  const autoTargetTimestampRef = useRef<number | null>(null);
  const signalPenDownPrevRef = useRef(false);
  const replayLoadedRef = useRef(false);
  const pendingRecordingSelectionRef = useRef<string | null>(null);
  const replayEmitIntervalsRef = useRef<number[]>([]);
  const replaySourceLagsRef = useRef<number[]>([]);
  const lastDecoderPacketArrivalMsRef = useRef<number | null>(null);
  const manualDecodeInFlightRef = useRef(false);
  const manualDecodeLastSentAtRef = useRef(0);

  useEffect(() => {
    penUpSinceRef.current = performance.now();
  }, []);

  useLayoutEffect(() => {
    controlModeRef.current = controlMode;
    cursorDisplayRef.current = cursorDisplay;
    decoderDataRef.current = decoderData;
    manualPenDownRef.current = manualPenDown;
    spikeStrengthRef.current = spikeStrength;
    replayLoadedRef.current = replayLoaded;
  }, [controlMode, cursorDisplay, decoderData, manualPenDown, replayLoaded, spikeStrength]);

  const handleKeyPress = useCallback((keyId: string) => {
    setSwipeSuggestions([]);
    if (keyId === "Backspace") {
      setFullText((prev) => prev.slice(0, -1));
    } else if (keyId === "Enter") {
      setFullText((prev) => prev + "\n");
    } else if (keyId === " ") {
      setFullText((prev) => prev + " ");
    } else if (keyId.length === 1 && /[A-Za-z]/.test(keyId)) {
      setFullText((prev) => prev + keyId.toUpperCase());
    } else {
      setFullText((prev) => prev + keyId);
    }
  }, []);

  const handleClearText = useCallback(() => {
    setSwipeSuggestions([]);
    setFullText("");
  }, []);

  const handleSwipeComplete = useCallback((keyIds: string[]) => {
    const words = predictSwipeWords(keyIds);
    setSwipeSuggestions(words);
  }, []);

  const prefixSuggestions = useMemo(() => getWordSuggestions(fullText), [fullText]);
  const suggestions = swipeSuggestions.length > 0 ? swipeSuggestions : prefixSuggestions;

  const handleSuggestionSelect = useCallback((word: string) => {
    setSwipeSuggestions([]);
    setFullText((prev) => applyWordSuggestion(prev, word));
  }, []);

  const setThoughtPanelIntentSynced = useCallback((active: boolean) => {
    if (thoughtPanelIntentRef.current === active) return;
    thoughtPanelIntentRef.current = active;
    setThoughtPanelIntent(active);
  }, []);

  const isPointerInsideThoughtPanel = useCallback((clientX: number, clientY: number) => {
    const el = thoughtPanelRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return (
      clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom
    );
  }, []);

  const onThoughtPanelPointerEnter = useCallback(() => {
    setThoughtPanelIntentSynced(true);
  }, [setThoughtPanelIntentSynced]);

  const onThoughtPanelPointerLeave = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const next = e.relatedTarget;
      if (next instanceof Node && thoughtPanelRef.current?.contains(next)) {
        return;
      }
      setThoughtPanelIntentSynced(false);
    },
    [setThoughtPanelIntentSynced],
  );

  useEffect(() => {
    const onWindowBlur = () => setThoughtPanelIntentSynced(false);
    window.addEventListener("blur", onWindowBlur);
    return () => window.removeEventListener("blur", onWindowBlur);
  }, [setThoughtPanelIntentSynced]);

  useEffect(() => {
    if (!thoughtPanelIntent) return;

    const verifyPointerStillInside = (e: PointerEvent) => {
      if (!isPointerInsideThoughtPanel(e.clientX, e.clientY)) {
        setThoughtPanelIntentSynced(false);
      }
    };

    document.addEventListener("pointermove", verifyPointerStillInside);
    document.addEventListener("pointerup", verifyPointerStillInside);
    document.addEventListener("pointercancel", verifyPointerStillInside);
    return () => {
      document.removeEventListener("pointermove", verifyPointerStillInside);
      document.removeEventListener("pointerup", verifyPointerStillInside);
      document.removeEventListener("pointercancel", verifyPointerStillInside);
    };
  }, [thoughtPanelIntent, isPointerInsideThoughtPanel, setThoughtPanelIntentSynced]);

  const syncManualVelocityFromHeld = useCallback(() => {
    const v = netVelocityFromHeld(manualDirectionsHeldRef.current);
    manualVelocityRef.current = v;
    setManualCmd(v);
  }, []);

  const fireManualVelocitySpike = useCallback((vx: number, vy: number) => {
    const c = sampleSpikeConfidence();
    latestSpikeConfidenceRef.current = c;
    spikePulseEnvelopeRef.current = 1;
    const duration = 300 + Math.random() * 300;
    const start = Date.now();
    setManualNeuralBurst({ startMs: start, endMs: start + duration, vx, vy });
  }, []);

  const requestManualDecoderMetrics = useCallback(
    async (vx: number, vy: number, penDown: boolean) => {
      if (manualDecodeInFlightRef.current) return;
      const now = performance.now();
      if (now - manualDecodeLastSentAtRef.current < MANUAL_DECODE_MIN_INTERVAL_MS) return;
      manualDecodeInFlightRef.current = true;
      manualDecodeLastSentAtRef.current = now;
      try {
        const response = await fetch(BACKEND_ENDPOINTS.manualDecoderPredict, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vx,
            vy,
            pen_down: penDown,
            batch_samples: 20,
          }),
        });
        if (!response.ok) return;
        const packet = (await response.json()) as DecoderPacket;
        if (typeof packet.num_channels === "number" && packet.num_channels >= 1) {
          setTotalChannels(Math.floor(packet.num_channels));
        }
        if (controlModeRef.current !== "manual") return;
        setDecoderData(packet);
      } catch {
        /* ignore */
      } finally {
        manualDecodeInFlightRef.current = false;
      }
    },
    [],
  );

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
    setManualPenDown(false);
    setManualTrackpadActive(false);
    latestSpikeConfidenceRef.current = null;
    spikePulseEnvelopeRef.current = 0;
    setSpikeStrength(0);
    setManualNeuralBurst(null);
    lastManualPadSpeedRef.current = 0;
    manualDecodeInFlightRef.current = false;
  }, []);

  const absorbManualTrackpadFrame = useCallback(
    (pad: ManualTrackpadDrive, now: number) => {
      setManualTrackpadActive((prev) => (prev === pad.active ? prev : pad.active));

      if (!pad.active) {
        manualVelocityRef.current = { vx: 0, vy: 0 };
        setManualCmd({ vx: 0, vy: 0 });
        setManualPenDown(false);
        lastManualPadSpeedRef.current = 0;
        return;
      }

      manualVelocityRef.current = { vx: pad.vx, vy: pad.vy };
      setManualCmd({ vx: pad.vx, vy: pad.vy });
      setManualPenDown(pad.penDown);
      const n = Math.hypot(pad.vx, pad.vy);

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
      autoCursorTargetRef.current = { x: cx, y: cy };
      autoTargetTimestampRef.current = null;
      setCursorDisplay({ x: cx, y: cy });
      applyManualRest();
      manualTrackpadDriveRef.current = idleManualTrackpadDrive();
      trackpadRef.current?.clearKeyboard();
      setSwipeSuggestions([]);
      signalSmoothRef.current = 0;
      setSignalPct(0);
      penUpSinceRef.current = performance.now();
      replayEmitIntervalsRef.current = [];
      replaySourceLagsRef.current = [];
      lastDecoderPacketArrivalMsRef.current = null;
      setReplayLatencyStats(null);
    },
    [applyManualRest],
  );

  const resetReplayLatencyStats = useCallback(() => {
    replayEmitIntervalsRef.current = [];
    replaySourceLagsRef.current = [];
    lastDecoderPacketArrivalMsRef.current = null;
    setReplayLatencyStats(null);
  }, []);

  const selectControlMode = useCallback((mode: ControlMode) => {
    controlModeRef.current = mode;
    setControlMode(mode);
    if (mode === "manual") {
      setDecoderData(null);
      resetReplayLatencyStats();
      latestSpikeConfidenceRef.current = null;
      spikePulseEnvelopeRef.current = 0;
      setSpikeStrength(0);
    }
    setManualNeuralBurst(null);
  }, [resetReplayLatencyStats]);

  const refreshRecordings = useCallback(async () => {
    try {
      const r = await fetch(BACKEND_ENDPOINTS.recordings);
      if (!r.ok) return;
      const j = (await r.json()) as RecordingsResponse;
      const next = Array.isArray(j.recordings) ? j.recordings : [];
      setRecordings(next);
      if (!selectedRecordingFile && next.length > 0) {
        setSelectedRecordingFile(next[0].recording_file);
      }
      if (typeof j.selected_recording_id === "string") {
        const selected = next.find((item) => item.recording_id === j.selected_recording_id);
        if (selected) {
          setSelectedRecordingFile(selected.recording_file);
        }
      }
    } catch {
      /* ignore */
    }
  }, [selectedRecordingFile]);

  const refreshPlaybackStatus = useCallback(async () => {
    try {
      const r = await fetch(BACKEND_ENDPOINTS.playback);
      if (!r.ok) return;
      const j = (await r.json()) as PlaybackStatusResponse;
      setReplayPaused(Boolean(j.paused));
      setReplayLoaded(Boolean(j.replay_loaded ?? j.replay_active));
      if (typeof j.recording_file === "string" && j.recording_file.length > 0) {
        const pending = pendingRecordingSelectionRef.current;
        if (pending && j.recording_file !== pending) {
          return;
        }
        if (pending && j.recording_file === pending) {
          pendingRecordingSelectionRef.current = null;
        }
        setSelectedRecordingFile(j.recording_file);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const refreshRedisStatus = useCallback(async () => {
    try {
      const r = await fetch(BACKEND_ENDPOINTS.healthRedis);
      if (!r.ok) {
        setRedisStatus("error");
        setRedisStream(null);
        return;
      }
      const j = (await r.json()) as RedisHealthResponse;
      const nextStatus = j.status === "ok" || j.status === "disabled" ? j.status : "error";
      setRedisStatus(nextStatus);
      setRedisStream(typeof j.stream === "string" && j.stream.length > 0 ? j.stream : null);
    } catch {
      setRedisStatus("error");
      setRedisStream(null);
    }
  }, []);

  const refreshModelStatus = useCallback(async () => {
    try {
      const r = await fetch(BACKEND_ENDPOINTS.decoderInfo);
      if (!r.ok) {
        setModelStatus("error");
        setModelLabel("Unknown model");
        return;
      }
      const j = (await r.json()) as DecoderInfoResponse;
      const nextLabel =
        typeof j.model_type === "string" && j.model_type.trim().length > 0
          ? j.model_type
          : typeof j.regressor === "string" && j.regressor.trim().length > 0
            ? j.regressor
            : "Unknown model";
      setModelLabel(nextLabel);
      setModelStatus(j.is_trained ? "ready" : "fallback");
    } catch {
      setModelStatus("error");
      setModelLabel("Unknown model");
    }
  }, []);

  const sendReplayPlaybackCommand = useCallback(
    async (
      action: "play" | "pause" | "restart" | "set_speed",
      payload?: { speed?: number },
    ) => {
      setReplayBusy(true);
      try {
        const body: { action: string; speed?: number; progress?: number } = { action };
        if (action === "set_speed" && typeof payload?.speed === "number") {
          body.speed = payload.speed;
        }
        const r = await fetchWithTimeout(BACKEND_ENDPOINTS.playback, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) return;
        const j = (await r.json()) as PlaybackStatusResponse & { status?: string };
        if (j.status && j.status !== "ok") return;
        if (action === "pause") {
          setReplayPaused(true);
        } else if (action === "play") {
          setReplayPaused(false);
        } else if (action === "restart") {
          setReplayPaused(false);
        }
        if (typeof j.recording_file === "string" && j.recording_file.length > 0) {
          setSelectedRecordingFile(j.recording_file);
        }
        setReplayLoaded(Boolean(j.replay_loaded ?? j.replay_active));
      } catch {
        /* ignore */
      } finally {
        setReplayBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    void fetch(BACKEND_ENDPOINTS.simulatorConfig)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (j: {
          num_channels?: number;
        } | null) => {
        if (j && typeof j.num_channels === "number" && j.num_channels >= 1) {
          setTotalChannels(Math.floor(j.num_channels));
        }
      },
      )
      .catch(() => {});
    const bootstrapTimer = window.setTimeout(() => {
      void refreshRecordings();
      void refreshPlaybackStatus();
      void refreshRedisStatus();
      void refreshModelStatus();
    }, 0);
    return () => window.clearTimeout(bootstrapTimer);
  }, [refreshModelStatus, refreshPlaybackStatus, refreshRecordings, refreshRedisStatus]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshRedisStatus();
      void refreshModelStatus();
    }, 10000);
    return () => window.clearInterval(id);
  }, [refreshModelStatus, refreshRedisStatus]);

  useEffect(() => {
    if (controlMode !== "automatic") return;
    const id = window.setInterval(() => {
      void refreshPlaybackStatus();
    }, 250);
    return () => window.clearInterval(id);
  }, [controlMode, refreshPlaybackStatus]);

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
        const arrivalMs = performance.now();
        const previousArrivalMs = lastDecoderPacketArrivalMsRef.current;
        if (previousArrivalMs != null) {
          const emitIntervalMs = Math.max(0, arrivalMs - previousArrivalMs);
          replayEmitIntervalsRef.current.push(emitIntervalMs);
          if (replayEmitIntervalsRef.current.length > REPLAY_STATS_WINDOW) {
            replayEmitIntervalsRef.current.shift();
          }
        }
        lastDecoderPacketArrivalMsRef.current = arrivalMs;
        const sourceLagMs = Math.max(0, Date.now() - data.timestamp_ms);
        replaySourceLagsRef.current.push(sourceLagMs);
        if (replaySourceLagsRef.current.length > REPLAY_STATS_WINDOW) {
          replaySourceLagsRef.current.shift();
        }
        if (replayEmitIntervalsRef.current.length >= 8 && replaySourceLagsRef.current.length >= 8) {
          const emit = summarizeWindow(replayEmitIntervalsRef.current);
          const lag = summarizeWindow(replaySourceLagsRef.current);
          setReplayLatencyStats({
            meanEmitIntervalMs: emit.mean,
            p95EmitIntervalMs: emit.p95,
            meanSourceLagMs: lag.mean,
            p95SourceLagMs: lag.p95,
          });
        }
        const rawTarget = {
          x: data.cursor_x ?? 0.5,
          y: data.cursor_y ?? 0.5,
        };
        const prevTarget = autoCursorTargetRef.current;
        const dx = rawTarget.x - prevTarget.x;
        const dy = rawTarget.y - prevTarget.y;
        const dist = Math.hypot(dx, dy);
        const replayBoost = replayLoadedRef.current ? AUTO_REPLAY_SMOOTH_BOOST : 1;
        const targetDeadzone = AUTO_TARGET_DEADZONE_NORM * (replayLoadedRef.current ? 0.5 : 1);
        const packetTs = data.timestamp_ms;
        const prevTs = autoTargetTimestampRef.current;
        autoTargetTimestampRef.current = packetTs;
        const dt =
          prevTs != null && packetTs > prevTs ? Math.min((packetTs - prevTs) / 1000, 0.08) : 1 / 60;

        if (dist <= targetDeadzone) {
          return;
        }
        if (dist >= AUTO_TARGET_JUMP_SNAP_NORM) {
          autoCursorTargetRef.current = rawTarget;
          return;
        }
        const alpha = 1 - Math.exp(-AUTO_TARGET_SMOOTH_PER_S * replayBoost * dt);
        autoCursorTargetRef.current = {
          x: prevTarget.x + dx * alpha,
          y: prevTarget.y + dy * alpha,
        };
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
    if (controlMode === "manual") {
      const { x, y } = cursorDisplayRef.current;
      manualPhysicsRef.current = seedCursorMotion(x, y);
    } else {
      const { x, y } = cursorDisplayRef.current;
      autoCursorTargetRef.current = { x, y };
      autoTargetTimestampRef.current = null;
    }
  }, [controlMode]);

  useEffect(() => {
    if (controlMode !== "automatic") return;

    let frameId = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.064);
      last = now;
      const replayBoost = replayLoadedRef.current ? AUTO_REPLAY_SMOOTH_BOOST : 1;
      const deadzoneScale = replayLoadedRef.current ? AUTO_REPLAY_DEADZONE_SCALE : 1;
      const deadzoneSq =
        (AUTO_CURSOR_DEADZONE_NORM * deadzoneScale) * (AUTO_CURSOR_DEADZONE_NORM * deadzoneScale);
      const target = autoCursorTargetRef.current;
      const curr = cursorDisplayRef.current;
      const dx = target.x - curr.x;
      const dy = target.y - curr.y;
      const distSq = dx * dx + dy * dy;
      if (distSq > deadzoneSq) {
        const pkt = decoderDataRef.current;
        const speed = pkt ? Math.hypot(pkt.vx, pkt.vy) : 0;
        const boost = 1 + Math.min(1, speed) * AUTO_CURSOR_VELOCITY_BOOST_MAX;
        const alpha = 1 - Math.exp(-AUTO_CURSOR_SMOOTH_PER_S * replayBoost * boost * dt);
        const next = {
          x: curr.x + dx * alpha,
          y: curr.y + dy * alpha,
        };
        cursorDisplayRef.current = next;
        setCursorDisplay(next);
      }

      frameId = requestAnimationFrame(loop);
    };

    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
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
        void requestManualDecoderMetrics(pad.vx, pad.vy, pad.penDown);
      } else {
        setManualTrackpadActive((prev) => (prev ? false : prev));
        if (keysHeld) {
          const { vx: cmdVx, vy: cmdVy } = manualVelocityRef.current;
          const effectiveConfidence =
            Math.hypot(cmdVx, cmdVy) > 1e-6 && latestSpikeConfidenceRef.current != null
              ? latestSpikeConfidenceRef.current * spikePulseEnvelopeRef.current
              : 0;

          manualPhysicsRef.current = stepCursorMotion(
            manualPhysicsRef.current,
            cmdVx,
            cmdVy,
            effectiveConfidence,
            dt,
          );
          const { xSmooth, ySmooth } = manualPhysicsRef.current;
          setCursorDisplay({ x: xSmooth, y: ySmooth });
          void requestManualDecoderMetrics(cmdVx, cmdVy, manualPenDownRef.current);

          setSpikeStrength(effectiveConfidence);
        } else {
          manualVelocityRef.current = { vx: 0, vy: 0 };
          setSpikeStrength(0);
        }
      }

      frameId = requestAnimationFrame(loop);
    };

    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [controlMode, absorbManualTrackpadFrame, requestManualDecoderMetrics]);

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

  /** Actual click / pen_down — drives key select and pressed-key visuals. */
  const clickActionPenDown =
    controlMode === "manual" ? manualPenDown : (decoderData?.pen_down ?? false);

  useEffect(() => {
    let frameId = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.064);
      last = now;

      const mode = controlModeRef.current;
      const penDown =
        mode === "manual"
          ? manualPenDownRef.current
          : (decoderDataRef.current?.pen_down ?? false);
      if (!penDown && signalPenDownPrevRef.current) {
        penUpSinceRef.current = now;
      }
      signalPenDownPrevRef.current = penDown;
      const penUpIdleSec = penDown ? 0 : (now - penUpSinceRef.current) / 1000;

      let confidence: number;
      let velocityMag: number;
      let spike: number;

      if (mode === "manual") {
        const pad = manualTrackpadDriveRef.current;
        const cmd = manualVelocityRef.current;
        const pkt = decoderDataRef.current;
        velocityMag = pkt ? Math.hypot(pkt.vx, pkt.vy) : pad.active ? Math.hypot(pad.vx, pad.vy) : Math.hypot(cmd.vx, cmd.vy);
        confidence = pkt?.confidence ?? 0;
        spike = pkt?.confidence ?? spikeStrengthRef.current;
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
      const boosted = Math.min(1, signalSmoothRef.current * SIGNAL_DISPLAY_GAIN + SIGNAL_DISPLAY_BIAS);
      setSignalPct(Math.round(boosted * 100));

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

  const handleClearKeyboard = () => {
    trackpadRef.current?.clearKeyboard();
    manualTrackpadDriveRef.current = idleManualTrackpadDrive();
    applyManualRest();
    setSwipeSuggestions([]);
    manualPhysicsRef.current = seedCursorMotion(0.5, 0.5);
    setCursorDisplay({ x: 0.5, y: 0.5 });
  };

  const manualDriving =
    controlMode === "manual" && (manualPenDown || manualTrackpadActive);
  const metricsVx = decoderData?.vx ?? (manualDriving ? manualCmd.vx : 0);
  const metricsVy = decoderData?.vy ?? (manualDriving ? manualCmd.vy : 0);
  const signalStyle = signalTierStyles(signalPct >= 67 ? "good" : signalPct >= 34 ? "medium" : "poor");

  const isComposing = clickActionPenDown;

  const displayConfidence = decoderData?.confidence ?? 0;

  const handleToggleReplayPlayback = () => {
    void sendReplayPlaybackCommand(replayPaused ? "play" : "pause");
  };

  const handleSelectRecording = (recordingFile: string) => {
    if (!recordingFile) return;
    resetReplayLatencyStats();
    pendingRecordingSelectionRef.current = recordingFile;
    setSelectedRecordingFile(recordingFile);
    setReplayBusy(true);
    void fetchWithTimeout(BACKEND_ENDPOINTS.selectRecording, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recording_file: recordingFile, timing: "original" }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { status?: string; recording_file?: string; selected_recording_id?: string } | null) => {
        if (!j || j.status !== "ok") return;
        if (typeof j.recording_file === "string") {
          setSelectedRecordingFile(j.recording_file);
        } else if (typeof j.selected_recording_id === "string") {
          setSelectedRecordingFile(`${j.selected_recording_id}.json`);
        }
        setReplayPaused(false);
      })
      .catch(() => {})
      .finally(() => {
        if (pendingRecordingSelectionRef.current === recordingFile) {
          pendingRecordingSelectionRef.current = null;
        }
        setReplayBusy(false);
        void refreshRecordings();
        void refreshPlaybackStatus();
      });
  };

  const handleRestartReplayPlayback = () => {
    void sendReplayPlaybackCommand("restart");
  };

  return (
    <div className="h-screen min-h-0 flex flex-col overflow-hidden bg-neuralink-bg text-neuralink-text">
      <header className="shrink-0 flex items-center justify-between gap-3 px-4 py-2.5 border-b border-neutral-800/90 bg-black/60 backdrop-blur-md">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="min-w-0">
            <h1 className="font-display text-sm sm:text-base font-semibold tracking-tight text-neutral-100 truncate">
              BCI Implant Dashboard
            </h1>
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

        <div className="shrink-0 flex items-center gap-2">
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-mono font-medium border ${
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

          <div
            className={`hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-mono font-medium border ${
              redisStatus === "ok"
                ? "border-emerald-500/40 text-emerald-300 bg-emerald-500/10"
                : redisStatus === "disabled"
                  ? "border-amber-500/35 text-amber-300 bg-amber-500/10"
                  : redisStatus === "checking"
                    ? "border-neutral-500/35 text-neutral-300 bg-neutral-500/10"
                    : "border-red-500/35 text-red-400 bg-red-500/5"
            }`}
            title={redisStream ? `Stream: ${redisStream}` : "Redis health status"}
          >
            Redis:{" "}
            {redisStatus === "ok"
              ? "Ready"
              : redisStatus === "disabled"
                ? "Disabled"
                : redisStatus === "checking"
                  ? "Checking"
                  : "Error"}
          </div>

          <div
            className={`hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-mono font-medium border ${
              modelStatus === "ready"
                ? "border-emerald-500/40 text-emerald-300 bg-emerald-500/10"
                : modelStatus === "fallback"
                  ? "border-amber-500/35 text-amber-300 bg-amber-500/10"
                  : modelStatus === "checking"
                    ? "border-neutral-500/35 text-neutral-300 bg-neutral-500/10"
                    : "border-red-500/35 text-red-400 bg-red-500/5"
            }`}
            title={modelLabel}
          >
            Model:{" "}
            {modelStatus === "ready"
              ? "Loaded"
              : modelStatus === "fallback"
                ? "Fallback"
                : modelStatus === "checking"
                  ? "Checking"
                  : "Error"}
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.35fr)] gap-2 p-2 overflow-hidden">
        {/* LEFT — decoder metrics + neural charts */}
        <aside className="order-2 lg:order-1 min-h-0 min-w-0 flex flex-col gap-2 overflow-hidden">
          <DecoderMetrics
            metricsVx={metricsVx}
            metricsVy={metricsVy}
            displayConfidence={displayConfidence}
            clickActive={clickActionPenDown}
            decoderData={decoderData}
            replayLatencyStats={replayLatencyStats}
            signalPct={signalPct}
            signalStyle={signalStyle}
            onResetDecoder={() => void resetDecoderState()}
          />

          <div className="flex-1 min-h-0 flex flex-col overflow-hidden rounded-xl border border-emerald-900/25 bg-black/30">
            <NeuralSignalCharts
              controlMode={controlMode}
              manualBurst={manualNeuralBurst}
              totalChannels={totalChannels}
              penDown={clickActionPenDown}
              vx={metricsVx}
              vy={metricsVy}
              compact
            />
          </div>
        </aside>

        {/* CENTER — unified typing workspace */}
        <ThoughtToText
          ref={thoughtPanelRef}
          fullText={fullText}
          placeholder={FULL_TEXT_PLACEHOLDER}
          thoughtPanelIntent={thoughtPanelIntent}
          isComposing={isComposing}
          onClearText={handleClearText}
          onPointerEnter={onThoughtPanelPointerEnter}
          onPointerLeave={onThoughtPanelPointerLeave}
          onPointerCancel={() => setThoughtPanelIntentSynced(false)}
          onClearKeyboard={handleClearKeyboard}
          showWaitingDecoder={controlMode === "automatic" && !decoderData}
          footerControls={
            controlMode === "automatic" ? (
              <div className="flex items-center gap-2 rounded-lg border border-neutral-700/80 bg-black/60 px-2 py-1">
                <label className="sr-only" htmlFor="recording-select">
                  Replay recording
                </label>
                <select
                  id="recording-select"
                  value={selectedRecordingFile ?? recordings[0]?.recording_file ?? ""}
                  onChange={(e) => handleSelectRecording(e.target.value)}
                  disabled={recordings.length === 0}
                  className="w-32 rounded-md border border-neutral-700/80 bg-neutral-950/90 px-2 py-1 text-[11px] font-mono text-neutral-200 outline-none focus:border-neuralink-accent/60 disabled:opacity-45"
                >
                  {recordings.length === 0 ? (
                    <option value="">No recordings</option>
                  ) : (
                    recordings.map((recording) => (
                      <option key={recording.recording_file} value={recording.recording_file}>
                        {recording.label}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  onClick={handleToggleReplayPlayback}
                  disabled={replayBusy || !replayLoaded}
                  className="rounded-md border border-neutral-700/80 bg-neutral-950/90 px-2 py-1 text-[11px] font-semibold text-neutral-200 transition-colors hover:bg-neutral-800/80 disabled:opacity-45"
                >
                  {replayPaused ? "Play" : "Pause"}
                </button>
                <button
                  type="button"
                  onClick={handleRestartReplayPlayback}
                  disabled={replayBusy || !replayLoaded}
                  className="rounded-md border border-neutral-700/80 bg-neutral-950/90 px-2 py-1 text-[11px] font-semibold text-neutral-200 transition-colors hover:bg-neutral-800/80 disabled:opacity-45"
                >
                  Restart
                </button>
              </div>
            ) : null
          }
        >
          <BCITrackpad
            ref={trackpadRef}
            className="absolute inset-0"
            controlMode={controlMode}
            cursorNorm={cursorDisplay}
            vx={controlMode === "manual" ? manualCmd.vx : (decoderData?.vx ?? 0)}
            vy={controlMode === "manual" ? manualCmd.vy : (decoderData?.vy ?? 0)}
            penDown={clickActionPenDown}
            manualDriveRef={manualTrackpadDriveRef}
            onKeyPress={handleKeyPress}
            onSwipeComplete={handleSwipeComplete}
            suggestions={suggestions}
            onSuggestionSelect={handleSuggestionSelect}
          />
        </ThoughtToText>

      </main>
    </div>
  );
}

export default App;
