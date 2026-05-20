interface DecoderMetricsPacket {
  latency_ms: number;
}

interface DecoderMetricsProps {
  metricsVx: number;
  metricsVy: number;
  displayConfidence: number;
  clickActive: boolean;
  decoderData: DecoderMetricsPacket | null;
  signalPct: number;
  signalStyle: {
    text: string;
    border: string;
    bar: string;
  };
  onResetDecoder: () => void;
}

function signalStrengthLabel(signalPct: number): "Weak" | "Moderate" | "Strong" {
  if (signalPct >= 67) return "Strong";
  if (signalPct >= 34) return "Moderate";
  return "Weak";
}

export function DecoderMetrics({
  metricsVx,
  metricsVy,
  displayConfidence,
  clickActive,
  decoderData,
  signalPct,
  signalStyle,
  onResetDecoder,
}: DecoderMetricsProps) {
  const velocityMag = Math.hypot(metricsVx, metricsVy);
  const velocityText = `vx ${metricsVx >= 0 ? "+" : ""}${metricsVx.toFixed(2)}  vy ${
    metricsVy >= 0 ? "+" : ""
  }${metricsVy.toFixed(2)}  |v| ${velocityMag.toFixed(2)}`;
  const confidencePct = Math.round(displayConfidence * 100);
  const latencyText = decoderData ? `${decoderData.latency_ms.toFixed(0)} ms` : "—";
  const strengthLabel = signalStrengthLabel(signalPct);

  return (
    <section className="shrink-0 basis-[42%] min-h-0 rounded-xl border border-neutral-800/90 bg-gradient-to-b from-neutral-900/85 to-black/65 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[10px] font-mono font-semibold uppercase tracking-[0.2em] text-neutral-400">
          Decoder metrics
        </h2>
      </div>

      <div className="space-y-2">
        <div className="rounded-lg border border-neutral-800/90 bg-black/35 px-2.5 py-2">
          <p className="text-[9px] font-mono uppercase tracking-[0.14em] text-neutral-500">vx / vy / |v|</p>
          <p className="mt-0.5 text-[13px] font-mono font-semibold tracking-tight text-cyan-300 tabular-nums">
            {velocityText}
          </p>
        </div>

        <div className="rounded-lg border border-neutral-800/90 bg-black/35 px-2.5 py-2">
          <p className="text-[9px] font-mono uppercase tracking-[0.14em] text-neutral-500">Confidence</p>
          <p className="mt-0.5 text-2xl font-semibold leading-none tracking-tight text-emerald-300 tabular-nums">
            {confidencePct}%
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-2 text-[10px] font-mono">
          <div className="rounded-lg border border-neutral-800/90 bg-black/30 px-2.5 py-1.5">
            <dt className="uppercase tracking-[0.14em] text-neutral-500">Latency</dt>
            <dd className="mt-0.5 tabular-nums text-neutral-200">{latencyText}</dd>
          </div>

          <div className="rounded-lg border border-neutral-800/90 bg-black/30 px-2.5 py-1.5">
            <dt className="uppercase tracking-[0.14em] text-neutral-500">Click</dt>
            <dd
              className={`mt-0.5 font-semibold ${
                clickActive ? "text-emerald-300" : "text-neutral-400"
              }`}
            >
              {clickActive ? "Click Active" : "Click Idle"}
            </dd>
          </div>
        </dl>

        <div className="rounded-lg border border-neutral-800/90 bg-black/30 px-2.5 py-1.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[9px] font-mono uppercase tracking-[0.14em] text-neutral-500">
              Signal strength
            </span>
            <span className={`text-[11px] font-mono font-semibold tabular-nums ${signalStyle.text}`}>
              {signalPct}%
            </span>
          </div>
          <div
            className={`h-1.5 overflow-hidden rounded-full border bg-neutral-950 ${signalStyle.border}`}
            title="Smoothed neural signal quality"
          >
            <div
              className={`h-full rounded-full bg-gradient-to-r transition-[width] duration-75 ${signalStyle.bar}`}
              style={{ width: `${signalPct}%` }}
            />
          </div>
          <p className="mt-1 text-[10px] font-mono font-semibold text-neutral-300">{strengthLabel}</p>
        </div>

        <div className="pt-0.5">
          <button
            type="button"
            onClick={onResetDecoder}
            className="w-full rounded-lg border border-neutral-600/80 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-200 transition-colors hover:bg-neutral-800/80"
          >
            Reset decoder
          </button>
        </div>
      </div>
    </section>
  );
}
