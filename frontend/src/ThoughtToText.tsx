import { forwardRef, type ReactNode } from "react";
import { DASHBOARD_BTN, DASHBOARD_DIVIDER, DASHBOARD_INNER_SURFACE, DASHBOARD_PANEL, DASHBOARD_PANEL_HEADER } from "./dashboardTheme";

interface ThoughtToTextProps {
  fullText: string;
  placeholder: string;
  thoughtPanelIntent: boolean;
  isComposing: boolean;
  onClearText: () => void;
  onPointerEnter: () => void;
  onPointerLeave: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onClearKeyboard: () => void;
  showWaitingDecoder: boolean;
  footerControls?: ReactNode;
  children: ReactNode;
}

export const ThoughtToText = forwardRef<HTMLElement, ThoughtToTextProps>(function ThoughtToText(
  {
    fullText,
    placeholder,
    thoughtPanelIntent,
    isComposing,
    onClearText,
    onPointerEnter,
    onPointerLeave,
    onPointerCancel,
    onClearKeyboard,
    showWaitingDecoder,
    footerControls,
    children,
  },
  ref,
) {
  return (
    <section
      ref={ref}
      className={`order-1 lg:order-2 flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden ${DASHBOARD_PANEL}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerCancel={onPointerCancel}
    >
      <div className={`shrink-0 flex items-center justify-between gap-3 px-3 py-2.5 border-b ${DASHBOARD_DIVIDER}`}>
        <h2 className={DASHBOARD_PANEL_HEADER}>Thought → Text</h2>
        <div className="flex items-center gap-2">
          {thoughtPanelIntent ? (
            <span className="text-[9px] font-mono font-medium text-emerald-400/95 uppercase tracking-wider animate-bci-pulse">
              Live
            </span>
          ) : (
            <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-wider">Standby</span>
          )}
          <button
            type="button"
            onClick={onClearText}
            disabled={fullText.length === 0}
            className={`px-2.5 py-1 disabled:opacity-35 disabled:pointer-events-none ${DASHBOARD_BTN}`}
          >
            Clear
          </button>
        </div>
      </div>

      <div className={`shrink-0 h-[4.5rem] px-3 py-2 border-b ${DASHBOARD_DIVIDER} overflow-y-auto`}>
        <p
          className={`font-mono text-lg font-medium leading-snug tracking-tight break-words whitespace-pre-wrap ${
            fullText.length === 0 ? "text-neutral-600 text-sm" : "text-neutral-100"
          }`}
          aria-live="polite"
        >
          {fullText.length === 0 ? placeholder : fullText}
          {isComposing && fullText.length > 0 ? (
            <span
              className="inline-block w-[2px] h-[0.85em] ml-0.5 align-middle rounded-sm bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)] animate-bci-caret"
              aria-hidden
            />
          ) : null}
        </p>
      </div>

      <div className={`relative flex-1 min-h-[14rem] w-full ${DASHBOARD_INNER_SURFACE}`}>{children}</div>

      <div className={`shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-t ${DASHBOARD_DIVIDER}`}>
        <div className="min-w-0 flex-1">{footerControls}</div>
        <button type="button" onClick={onClearKeyboard} className={`shrink-0 px-2.5 py-1 ${DASHBOARD_BTN}`}>
          Reset cursor
        </button>
      </div>
      {showWaitingDecoder && (
        <p className="shrink-0 px-3 pb-1.5 text-[10px] font-mono text-amber-500/80">Waiting for decoder stream…</p>
      )}
    </section>
  );
});
