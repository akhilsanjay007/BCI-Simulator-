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
import {
  drawSwipeTrail,
  hitKey,
  type KeyDef,
  type SwipeTrailPoint,
} from "../utils/keyboardLayout";
import { drawKeyboard } from "./Keyboard";
import { drawSuggestionBar, hitSuggestion } from "./SuggestionBar";
import { DASHBOARD_THEME } from "../utils/dashboardTheme";
import { idleManualTrackpadDrive, type ManualTrackpadDrive } from "../utils/manualTrackpad";

const T = DASHBOARD_THEME;

/** Minimum ms between chip presses (prevents accidental double-fire). */
const PRESS_COOLDOWN_MS = 120;
/** Hard cap on the swipe key path length — defensive against pathological glides. */
const MAX_SWIPE_PATH = 32;
/** Max cursor samples kept for the trail (~4 s @ 60 fps dense sampling). */
const MAX_SWIPE_POINTS = 240;
/**
 * Normalized squared step below which we skip duplicate samples — small enough
 * to capture fluid motion at pointer-event rate without stacking when still.
 */
const SWIPE_MIN_STEP_SQ = 0.00012 * 0.00012;

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
  /** Fired on release when the press only touched one key (single click). */
  onKeyPress: (keyId: string) => void;
  /** Fired on release when the press swept through ≥ 2 keys (swipe). */
  onSwipeComplete: (keyIds: string[]) => void;
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

type SwipeState = {
  /** Ordered, consecutively-deduped list of keyboard keys touched this press. */
  keys: KeyDef[];
  /** Last key id appended — quick equality check for dedup. */
  lastKeyId: string | null;
  /** Press began on a suggestion chip — bypass key/swipe handling for this press. */
  chipHandled: boolean;
};

function freshSwipeState(): SwipeState {
  return { keys: [], lastKeyId: null, chipHandled: false };
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
    onSwipeComplete,
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
  const onSwipeCompleteRef = useRef(onSwipeComplete);
  const onSuggestionSelectRef = useRef(onSuggestionSelect);
  const suggestionsRef = useRef(suggestions);
  const swipeStateRef = useRef<SwipeState>(freshSwipeState());
  /** Cursor sample ring buffer — populated only while pen is down. */
  const swipePointsRef = useRef<SwipeTrailPoint[]>([]);
  /** Scratch buffer: trail samples + live cursor head for paint (avoids alloc). */
  const trailDrawBufRef = useRef<SwipeTrailPoint[]>([]);

  const liveRef = useRef({
    cursorNorm,
    vx,
    vy,
    penDown,
    controlMode,
  });

  useLayoutEffect(() => {
    onKeyPressRef.current = onKeyPress;
    onSwipeCompleteRef.current = onSwipeComplete;
    onSuggestionSelectRef.current = onSuggestionSelect;
    suggestionsRef.current = suggestions;
  }, [onKeyPress, onSwipeComplete, onSuggestionSelect, suggestions]);

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
    swipeStateRef.current = freshSwipeState();
    swipePointsRef.current = [];
  }, []);

  const recordSwipePoint = (pt: NormPoint): void => {
    const arr = swipePointsRef.current;
    if (arr.length > 0) {
      const last = arr[arr.length - 1];
      const dx = pt.x - last.x;
      const dy = pt.y - last.y;
      if (dx * dx + dy * dy < SWIPE_MIN_STEP_SQ) return;
    }
    arr.push({ x: pt.x, y: pt.y });
    if (arr.length > MAX_SWIPE_POINTS) {
      arr.splice(0, arr.length - MAX_SWIPE_POINTS);
    }
  };

  /**
   * Single-source-of-truth keypress + swipe state machine, ticked every frame.
   *
   * - rising edge over a chip → fire suggestion immediately and mark this
   *   press as chip-handled (no trail recording for this press).
   * - rising edge over a key (or empty area) → seed the swipe path and start
   *   recording cursor samples for the trail.
   * - held + cursor enters a new key → append to the swipe path (deduped).
   * - held → keep recording cursor samples for the smooth trail.
   * - falling edge:
   *     • 1 key in path → single click → onKeyPress.
   *     • ≥ 2 keys in path → swipe → onSwipeComplete with ordered ids.
   */
  const tickPressMachine = useCallback((M: ReturnType<typeof mergedLive>) => {
    const now = performance.now();
    const wasPressed = prevPenDownRef.current;
    const isPressed = M.penDown;
    prevPenDownRef.current = isPressed;

    if (isPressed && !wasPressed) {
      swipePointsRef.current = [];
      const chip = hitSuggestion(M.cursorNorm.x, M.cursorNorm.y, suggestionsRef.current);
      if (chip) {
        swipeStateRef.current = { keys: [], lastKeyId: null, chipHandled: true };
        if (now >= pressCooldownUntilRef.current) {
          pressCooldownUntilRef.current = now + PRESS_COOLDOWN_MS;
          onSuggestionSelectRef.current(chip.word);
        }
        return;
      }
      swipeStateRef.current = freshSwipeState();
      const key = hitKey(M.cursorNorm.x, M.cursorNorm.y);
      if (key) {
        swipeStateRef.current.keys.push(key);
        swipeStateRef.current.lastKeyId = key.id;
      }
      recordSwipePoint(M.cursorNorm);
      return;
    }

    if (isPressed && wasPressed) {
      const s = swipeStateRef.current;
      if (s.chipHandled) return;
      recordSwipePoint(M.cursorNorm);
      const key = hitKey(M.cursorNorm.x, M.cursorNorm.y);
      if (key && key.id !== s.lastKeyId) {
        s.keys.push(key);
        s.lastKeyId = key.id;
        if (s.keys.length > MAX_SWIPE_PATH) {
          s.keys.splice(0, s.keys.length - MAX_SWIPE_PATH);
        }
      }
      return;
    }

    if (!isPressed && wasPressed) {
      const s = swipeStateRef.current;
      swipeStateRef.current = freshSwipeState();
      // Trail cleared on next paint so the release frame still shows the glide.
      if (s.chipHandled) {
        swipePointsRef.current = [];
      }
      if (s.chipHandled) return;
      if (s.keys.length >= 2) {
        onSwipeCompleteRef.current(s.keys.map((k) => k.id));
      } else if (s.keys.length === 1) {
        onKeyPressRef.current(s.keys[0].id);
      }
    }
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
    const swipeState = swipeStateRef.current;
    const swipeKeys = swipeState.keys;
    const swipingKeys = pressing && !swipeState.chipHandled;
    const swipedIds: Set<string> | null = swipingKeys
      ? (() => {
          const ids = new Set(swipeKeys.map((k) => k.id));
          if (hoveredKey) ids.add(hoveredKey.id);
          return ids.size > 0 ? ids : null;
        })()
      : null;
    const pressedChipIndex =
      pressing && swipeState.chipHandled && hoveredChip ? hoveredChip.index : null;
    const pressedKeyId = swipingKeys && hoveredKey ? hoveredKey.id : null;
    drawSuggestionBar({
      ctx,
      plotW,
      plotH,
      words,
      hoveredIndex: hoveredChip?.index ?? null,
      pressedIndex: pressedChipIndex,
    });
    drawKeyboard({
      ctx,
      plotW,
      plotH,
      hoveredId: hoveredKey?.id ?? null,
      pressedId: pressedKeyId,
      dpr,
      swipedIds,
    });
    if (swipingKeys) {
      const src = swipePointsRef.current;
      const head = M.cursorNorm;
      const buf = trailDrawBufRef.current;
      buf.length = 0;
      for (let i = 0; i < src.length; i++) buf.push(src[i]);
      if (buf.length === 0) {
        buf.push({ x: head.x, y: head.y });
      } else {
        const last = buf[buf.length - 1];
        const dx = head.x - last.x;
        const dy = head.y - last.y;
        if (dx * dx + dy * dy > SWIPE_MIN_STEP_SQ * 0.25) {
          buf.push({ x: head.x, y: head.y });
        }
      }
      if (buf.length >= 2) {
        drawSwipeTrail(ctx, plotW, plotH, buf);
      }
    } else if (!pressing && swipePointsRef.current.length >= 2) {
      const src = swipePointsRef.current;
      const buf = trailDrawBufRef.current;
      buf.length = 0;
      for (let i = 0; i < src.length; i++) buf.push(src[i]);
      const last = buf[buf.length - 1];
      const hx = M.cursorNorm.x;
      const hy = M.cursorNorm.y;
      if ((hx - last.x) ** 2 + (hy - last.y) ** 2 > SWIPE_MIN_STEP_SQ * 0.25) {
        buf.push({ x: hx, y: hy });
      }
      drawSwipeTrail(ctx, plotW, plotH, buf.length >= 2 ? buf : src);
      swipePointsRef.current = [];
    }

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
      tickPressMachine(M);
      paint();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [paint, mergedLive, tickPressMachine]);

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

      // High-rate samples on move (down edge is recorded in tickPressMachine).
      if (penDownBtn && active && prevPenDownRef.current && !swipeStateRef.current.chipHandled) {
        recordSwipePoint({ x: nx, y: ny });
      }
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
