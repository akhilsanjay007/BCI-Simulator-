import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type TrackpadSurfaceMode = "cursor" | "handwriting";

const INK = "rgba(52, 211, 153, 0.92)";
const INK_DIM = "rgba(52, 211, 153, 0.22)";
const BG = "#050505";
const GRID = "rgba(55, 65, 60, 0.35)";
const CURSOR_CORE = "#00ffaa";
const CURSOR_GLOW = "rgba(0, 255, 170, 0.45)";

type NormPoint = { x: number; y: number };

export interface BCITrackpadProps {
  controlMode: "automatic" | "manual";
  /** Normalized cursor [0,1]² — same source as dashboard physics / decoder. */
  cursorNorm: NormPoint;
  /** Velocity for HUD (decoder or manual). */
  vx: number;
  vy: number;
  /** Contact / ink gate from decoder (automatic) or pointer (manual handwriting). */
  penDown: boolean;
  surfaceMode: TrackpadSurfaceMode;
  onSurfaceModeChange: (mode: TrackpadSurfaceMode) => void;
  /** Manual mode: continuous joystick + pen from the pad (center = rest). */
  onManualPadSample: (sample: { vx: number; vy: number; penDown: boolean }) => void;
  className?: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function formatVel(vx: number, vy: number): string {
  const mag = Math.hypot(vx, vy);
  return `vx ${vx >= 0 ? "+" : ""}${vx.toFixed(2)} · vy ${vy >= 0 ? "+" : ""}${vy.toFixed(2)} · |v| ${mag.toFixed(2)}`;
}

/**
 * Large square canvas: live cursor, optional ink (handwriting + pen), mode + demo controls.
 */
export function BCITrackpad({
  controlMode,
  cursorNorm,
  vx,
  vy,
  penDown,
  surfaceMode,
  onSurfaceModeChange,
  onManualPadSample,
  className = "",
}: BCITrackpadProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Closed strokes + active stroke in normalized [0,1] coordinates. */
  const strokesRef = useRef<NormPoint[][]>([]);
  const activeStrokeRef = useRef<NormPoint[] | null>(null);
  const lastInkNormRef = useRef<NormPoint | null>(null);
  const [recognized, setRecognized] = useState("Awaiting recognition…");
  const [, bumpRedraw] = useState(0);
  const pointerOnPadRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);

  const pushInkPoint = useCallback((p: NormPoint) => {
    const last = lastInkNormRef.current;
    const dx = last ? p.x - last.x : 1;
    const dy = last ? p.y - last.y : 1;
    if (last && dx * dx + dy * dy < 1.2e-6) return;
    lastInkNormRef.current = p;
    let stroke = activeStrokeRef.current;
    if (!stroke) {
      stroke = [];
      activeStrokeRef.current = stroke;
      strokesRef.current.push(stroke);
    }
    stroke.push({ x: p.x, y: p.y });
  }, []);

  const closeStroke = useCallback(() => {
    activeStrokeRef.current = null;
    lastInkNormRef.current = null;
  }, []);

  const clearInk = useCallback(() => {
    strokesRef.current = [];
    activeStrokeRef.current = null;
    lastInkNormRef.current = null;
    setRecognized("Awaiting recognition…");
    bumpRedraw((n) => n + 1);
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const side = Math.max(200, Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight)));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.floor(side * dpr);
    canvas.height = Math.floor(side * dpr);
    canvas.style.width = `${side}px`;
    canvas.style.height = `${side}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, side, side);

    const g = 28;
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (let x = 0; x <= side; x += g) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, side);
      ctx.stroke();
    }
    for (let y = 0; y <= side; y += g) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(side, y + 0.5);
      ctx.stroke();
    }

    ctx.strokeStyle = INK_DIM;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(side / 2, 0);
    ctx.lineTo(side / 2, side);
    ctx.moveTo(0, side / 2);
    ctx.lineTo(side, side / 2);
    ctx.stroke();

    const toPx = (p: NormPoint) => ({
      x: clamp(p.x, 0, 1) * side,
      y: clamp(p.y, 0, 1) * side,
    });

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of strokesRef.current) {
      if (stroke.length < 2) continue;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2.35;
      ctx.beginPath();
      const p0 = toPx(stroke[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < stroke.length; i++) {
        const p = toPx(stroke[i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    const cx = clamp(cursorNorm.x, 0, 1) * side;
    const cy = clamp(cursorNorm.y, 0, 1) * side;
    ctx.fillStyle = CURSOR_GLOW;
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(cx, cy, 4.25, 0, Math.PI * 2);
    ctx.fillStyle = CURSOR_CORE;
    ctx.fill();
    ctx.stroke();
  }, [cursorNorm]);

  useLayoutEffect(() => {
    draw();
  }, [draw, vx, vy, penDown, surfaceMode, controlMode, recognized]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const ink =
        surfaceMode === "handwriting" &&
        penDown &&
        (controlMode === "automatic" || pointerOnPadRef.current);
      if (ink) {
        pushInkPoint({ x: cursorNorm.x, y: cursorNorm.y });
      } else {
        closeStroke();
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cursorNorm, surfaceMode, penDown, controlMode, draw, pushInkPoint, closeStroke]);

  const sampleJoystickFromEvent = (el: HTMLDivElement, clientX: number, clientY: number) => {
    const r = el.getBoundingClientRect();
    const mx = (clientX - r.left) / Math.max(1, r.width);
    const my = (clientY - r.top) / Math.max(1, r.height);
    let jx = (mx - 0.5) * 2;
    let jy = (my - 0.5) * 2;
    const m = Math.hypot(jx, jy);
    if (m > 1 && m > 1e-6) {
      jx /= m;
      jy /= m;
    }
    return { vx: jx, vy: jy };
  };

  const flushManualRest = useCallback(() => {
    pointerOnPadRef.current = false;
    pointerIdRef.current = null;
    onManualPadSample({ vx: 0, vy: 0, penDown: false });
  }, [onManualPadSample]);

  const onPointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (controlMode !== "manual") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerIdRef.current = e.pointerId;
    pointerOnPadRef.current = true;
    const { vx: jx, vy: jy } = sampleJoystickFromEvent(e.currentTarget, e.clientX, e.clientY);
    const pen = surfaceMode === "handwriting" && (e.buttons & 1) !== 0;
    onManualPadSample({ vx: jx, vy: jy, penDown: pen });
  };

  const onPointerMoveCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (controlMode !== "manual" || !pointerOnPadRef.current) return;
    const { vx: jx, vy: jy } = sampleJoystickFromEvent(e.currentTarget, e.clientX, e.clientY);
    const pen = surfaceMode === "handwriting" && (e.buttons & 1) !== 0;
    onManualPadSample({ vx: jx, vy: jy, penDown: pen });
  };

  const onPointerUpCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current === e.pointerId) {
      flushManualRest();
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onRecognize = () => {
    const strokes = strokesRef.current;
    const pts = strokes.reduce((a, s) => a + s.length, 0);
    setRecognized(
      pts < 8
        ? "(demo) Stroke too short — draw a letter, then Recognize."
        : "(demo) Recognizer not wired — backend hook coming soon.",
    );
  };

  const modeBtn = (mode: TrackpadSurfaceMode, label: string, hint: string) => (
    <button
      type="button"
      key={mode}
      title={hint}
      onClick={() => onSurfaceModeChange(mode)}
      className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-all border ${
        surfaceMode === mode
          ? "border-emerald-400/55 bg-emerald-500/15 text-emerald-200 shadow-[0_0_20px_-8px_rgba(52,211,153,0.5)]"
          : "border-neutral-700/90 bg-neutral-900/60 text-neutral-400 hover:text-neutral-200 hover:border-neutral-600"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className={`flex flex-col gap-2 min-h-0 ${className}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap shrink-0">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">Trackpad</h2>
        <span className="text-[10px] font-mono text-neutral-500">
          {controlMode === "manual" ? "Drag to steer · handwriting = draw while pressed" : "Decoder stream"}
        </span>
      </div>

      <div
        ref={wrapRef}
        className="relative mx-auto aspect-square w-full min-h-[12rem] max-h-[min(72vh,42rem)] max-w-[min(100%,72vh,42rem)] rounded-xl border border-neutral-800/90 bg-black overflow-hidden touch-none select-none shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
      >
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 block h-full w-full ${controlMode === "manual" ? "cursor-crosshair" : "cursor-default"}`}
          aria-label="BCI trackpad and handwriting canvas"
        />
        {controlMode === "manual" && (
          <div
            role="application"
            aria-label="Manual velocity joystick"
            className="absolute inset-0 z-10"
            onPointerDown={onPointerDownCapture}
            onPointerMove={onPointerMoveCapture}
            onPointerUp={onPointerUpCapture}
            onPointerCancel={onPointerUpCapture}
            onPointerLeave={(e) => {
              if (e.buttons === 0 && pointerOnPadRef.current) flushManualRest();
            }}
          />
        )}
        <div className="pointer-events-none absolute bottom-2 left-2 right-2 flex justify-between items-end gap-2">
          <p className="text-[10px] font-mono text-neutral-500 bg-black/55 px-2 py-1 rounded-md border border-white/5 backdrop-blur-sm max-w-[min(100%,20rem)] truncate">
            {formatVel(vx, vy)}
          </p>
          <p className="text-[10px] font-mono text-neutral-400 bg-black/55 px-2 py-1 rounded-md border border-white/5">
            pen {penDown ? "down" : "up"} · {surfaceMode === "handwriting" ? "HW" : "cursor"}
          </p>
        </div>
      </div>

      <div className="flex gap-1.5 shrink-0" role="group" aria-label="Ink mode">
        {modeBtn("cursor", "Cursor mode", "Move without leaving ink")}
        {modeBtn("handwriting", "Handwriting mode", "Hold primary button while dragging to write")}
      </div>

      <div className="flex flex-wrap gap-1.5 shrink-0">
        <button
          type="button"
          onClick={clearInk}
          className="rounded-lg border border-neutral-600 bg-neutral-900/80 px-3 py-1.5 text-[11px] font-medium text-neutral-200 hover:bg-neutral-800 hover:border-neutral-500 transition-colors"
        >
          Clear canvas
        </button>
        <button
          type="button"
          onClick={onRecognize}
          className="rounded-lg border border-emerald-600/50 bg-emerald-950/40 px-3 py-1.5 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-900/35 transition-colors"
        >
          Recognize
        </button>
      </div>

      <label className="shrink-0 text-[10px] font-mono text-neutral-500 uppercase tracking-wider">
        Recognized
        <input
          readOnly
          value={recognized}
          className="mt-1 w-full rounded-lg border border-neutral-800 bg-neutral-950/90 px-2.5 py-2 text-xs text-neutral-100 font-mono shadow-inner"
        />
      </label>
    </div>
  );
}
