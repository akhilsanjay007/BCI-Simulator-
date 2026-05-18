/**
 * Keyboard surface — virtual QWERTY (bottom) + BCI cursor.
 * rAF paint reads merged cursor/click (tablet ref in Manual removes one frame of lag).
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
} from "react";
import { drawKeyboard, drawSuggestions, hitKey, hitSuggestion } from "./keyboardLayout";
import { DASHBOARD_THEME } from "./dashboardTheme";
import { idleManualTrackpadDrive, type ManualTrackpadDrive } from "./manualTrackpad";

const T = DASHBOARD_THEME;

/** Minimum ms between key presses (debounce). */
const PRESS_COOLDOWN_MS = 120;

type NormPoint = { x: number; y: number };

interface BCITrackpadProps {
  controlMode: "automatic" | "manual";
  /** Normalized cursor [0,1]² — decoder or keyboard-smoothed physics. */
  cursorNorm: NormPoint;
  vx: number;
  vy: number;
  /** Select / click (decoder speed burst or manual left button). */
  penDown: boolean;
  manualDriveRef: MutableRefObject<ManualTrackpadDrive>;
  /** Fired once per click rising edge while cursor is over a key. */
  onKeyPress: (keyId: string) => void;
  /** Autocomplete chips shown above the keyboard. */
  suggestions: string[];
  /** Fired when a suggestion chip is clicked. */
  onSuggestionSelect: (word: string) => void;
  className?: string;
}

export type BCITrackpadHandle = {
  /** Reset press debounce state (e.g. after decoder reset). */
  clearKeyboard: () => void;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function fillScopeBackground(ctx: CanvasRenderingContext2D, plotW: number, plotH: number): void {
  const grad = ctx.createLinearGradient(0, 0, 0, plotH);
  grad.addColorStop(0, "rgba(0, 0, 0, 0.35)");
  grad.addColorStop(0.35, T.bg);
  grad.addColorStop(1, T.bg);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, plotW, plotH);
}

function normFromClient(wrap: HTMLDivElement, clientX: number, clientY: number): NormPoint {
  const r = wrap.getBoundingClientRect();
  const nx = clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
  const ny = clamp((clientY - r.top) / Math.max(1, r.height), 0, 1);
  return { x: nx, y: ny };
}

export const BCITrackpad = forwardRef<BCITrackpadHandle, BCITrackpadProps>(function BCITrackpad(
  {
    controlMode,
    cursorNorm,
    vx,
    vy,
    penDown,
    manualDriveRef,
    onKeyPress,
    suggestions,
    onSuggestionSelect,
    className = "",
  },
  ref,
) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastCanvasLayoutRef = useRef({ plotW: 0, plotH: 0, dpr: 0 });
  const velTrackRef = useRef({ nx: 0.5, ny: 0.5, t: performance.now() });
  const prevPenDownRef = useRef(false);
  const pressCooldownUntilRef = useRef(0);
  const onKeyPressRef = useRef(onKeyPress);
  const onSuggestionSelectRef = useRef(onSuggestionSelect);
  const suggestionsRef = useRef(suggestions);

  const liveRef = useRef({
    cursorNorm,
    vx,
    vy,
    penDown,
    controlMode,
  });

  useLayoutEffect(() => {
    onKeyPressRef.current = onKeyPress;
    onSuggestionSelectRef.current = onSuggestionSelect;
    suggestionsRef.current = suggestions;
  }, [onKeyPress, onSuggestionSelect, suggestions]);

  useLayoutEffect(() => {
    liveRef.current = { cursorNorm, vx, vy, penDown, controlMode };
  }, [cursorNorm, vx, vy, penDown, controlMode]);

  const mergedLive = useCallback(() => {
    const L = liveRef.current;
    const pad = manualDriveRef.current;
    if (L.controlMode === "manual" && pad.active) {
      return {
        cursorNorm: { x: pad.nx, y: pad.ny },
        vx: pad.vx,
        vy: pad.vy,
        penDown: pad.penDown,
        controlMode: L.controlMode,
      };
    }
    return {
      cursorNorm: L.cursorNorm,
      vx: L.vx,
      vy: L.vy,
      penDown: L.penDown,
      controlMode: L.controlMode,
    };
  }, [manualDriveRef]);

  const clearKeyboardState = useCallback(() => {
    prevPenDownRef.current = false;
    pressCooldownUntilRef.current = 0;
  }, []);

  const tryKeyPress = useCallback((M: ReturnType<typeof mergedLive>) => {
    const now = performance.now();
    const rising = M.penDown && !prevPenDownRef.current;
    prevPenDownRef.current = M.penDown;

    if (!rising || now < pressCooldownUntilRef.current) {
      return;
    }

    const chip = hitSuggestion(M.cursorNorm.x, M.cursorNorm.y, suggestionsRef.current);
    if (chip) {
      pressCooldownUntilRef.current = now + PRESS_COOLDOWN_MS;
      onSuggestionSelectRef.current(chip.word);
      return;
    }

    const key = hitKey(M.cursorNorm.x, M.cursorNorm.y);
    if (!key) {
      return;
    }

    pressCooldownUntilRef.current = now + PRESS_COOLDOWN_MS;
    onKeyPressRef.current(key.id);
  }, []);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const plotW = Math.max(200, Math.floor(wrap.clientWidth));
    const plotH = Math.max(160, Math.floor(wrap.clientHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const prev = lastCanvasLayoutRef.current;
    if (prev.plotW !== plotW || prev.plotH !== plotH || prev.dpr !== dpr) {
      lastCanvasLayoutRef.current = { plotW, plotH, dpr };
      canvas.width = Math.floor(plotW * dpr);
      canvas.height = Math.floor(plotH * dpr);
      canvas.style.width = `${plotW}px`;
      canvas.style.height = `${plotH}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    fillScopeBackground(ctx, plotW, plotH);

    const M = mergedLive();
    const words = suggestionsRef.current;
    const hoveredChip = hitSuggestion(M.cursorNorm.x, M.cursorNorm.y, words);
    const hoveredKey = hitKey(M.cursorNorm.x, M.cursorNorm.y);
    const pressing = M.penDown;
    const pressedChipIndex =
      pressing && hoveredChip ? hoveredChip.index : null;
    const pressedKeyId = pressing && hoveredKey ? hoveredKey.id : null;
    drawSuggestions(
      ctx,
      plotW,
      plotH,
      words,
      hoveredChip?.index ?? null,
      pressedChipIndex,
    );
    drawKeyboard(
      ctx,
      plotW,
      plotH,
      hoveredKey?.id ?? null,
      pressedKeyId,
      dpr,
    );

    const cx = clamp(M.cursorNorm.x, 0, 1) * plotW;
    const cy = clamp(M.cursorNorm.y, 0, 1) * plotH;
    const t = performance.now() / 1000;
    const pulse = 0.82 + 0.18 * Math.sin(t * 5.5);

    const rOuter = 24;
    const rMid = 13;
    const rCore = 4.2;
    const rHot = 2.6;

    const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, rOuter);
    bloom.addColorStop(0, `rgba(52, 211, 153, ${0.18 * pulse})`);
    bloom.addColorStop(0.45, `rgba(0, 255, 159, ${0.07 * pulse})`);
    bloom.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
    ctx.fill();

    const mid = ctx.createRadialGradient(cx, cy, 0, cx, cy, rMid);
    mid.addColorStop(0, `rgba(110, 231, 183, ${0.45 * pulse})`);
    mid.addColorStop(1, "rgba(52, 211, 153, 0)");
    ctx.fillStyle = mid;
    ctx.beginPath();
    ctx.arc(cx, cy, rMid, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = T.cursorRing;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "rgba(52, 211, 153, 0.85)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = T.cursorCore;
    ctx.beginPath();
    ctx.arc(cx, cy, rCore, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, rHot, 0, Math.PI * 2);
    ctx.fillStyle = "#e8fff8";
    ctx.fill();
    ctx.shadowBlur = 0;
  }, [mergedLive]);

  useImperativeHandle(
    ref,
    () => ({
      clearKeyboard: clearKeyboardState,
    }),
    [clearKeyboardState],
  );

  useLayoutEffect(() => {
    paint();
  }, [paint, controlMode]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => paint());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [paint]);

  useEffect(() => {
    let raf = 0;

    const tick = () => {
      const M = mergedLive();
      tryKeyPress(M);
      paint();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [paint, mergedLive, tryKeyPress]);

  const estimateVelocity = useCallback((nx: number, ny: number) => {
    const now = performance.now();
    const prev = velTrackRef.current;
    const dt = (now - prev.t) / 1000;
    if (dt > 0.07) {
      velTrackRef.current = { nx, ny, t: now };
      return { vx: 0, vy: 0 };
    }
    const dnx = nx - prev.nx;
    const dny = ny - prev.ny;
    velTrackRef.current = { nx, ny, t: now };
    const scale = 2.4;
    const effDt = Math.max(1e-4, dt);
    return {
      vx: clamp(dnx / effDt / scale, -1, 1),
      vy: clamp(dny / effDt / scale, -1, 1),
    };
  }, []);

  const writeDriveFromEvent = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const wrap = wrapRef.current;
      if (!wrap || controlMode !== "manual") return;

      const r = wrap.getBoundingClientRect();
      const inside =
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom;
      const dragging = (e.buttons & 1) !== 0;
      const active = inside || dragging;

      const { x: nx, y: ny } = normFromClient(wrap, e.clientX, e.clientY);
      const { vx: evx, vy: evy } = estimateVelocity(nx, ny);
      const penDownBtn = (e.buttons & 1) !== 0;

      manualDriveRef.current = {
        active,
        nx,
        ny,
        vx: active ? evx : 0,
        vy: active ? evy : 0,
        penDown: active && penDownBtn,
      };
    },
    [controlMode, estimateVelocity, manualDriveRef],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (controlMode !== "manual") return;
    if (e.button === 0) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    writeDriveFromEvent(e);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (controlMode !== "manual") return;
    writeDriveFromEvent(e);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    writeDriveFromEvent(e);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onPointerLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    if (controlMode !== "manual") return;
    if (e.buttons === 0) {
      manualDriveRef.current = idleManualTrackpadDrive();
    } else {
      writeDriveFromEvent(e);
    }
  };

  return (
    <div className={`relative h-full w-full min-h-0 min-w-0 ${className}`}>
      <div
        ref={wrapRef}
        role="application"
        aria-label="BCI virtual keyboard"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        className={`relative h-full w-full min-h-0 min-w-0 overflow-hidden touch-none select-none bg-transparent ${
          controlMode === "manual" ? "cursor-none" : "cursor-default"
        }`}
      >
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 block h-full w-full"
          aria-hidden
        />
      </div>
    </div>
  );
});
BCITrackpad.displayName = "BCITrackpad";
