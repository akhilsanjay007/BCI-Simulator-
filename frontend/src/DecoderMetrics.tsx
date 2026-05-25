interface DecoderMetricsPacket {
  decode_latency_ms: number;
  end_to_end_latency_ms: number;
  redis_buffer_seconds: number;
  accuracy: number;
  session_accuracy: number;
}

interface ReplayLatencyStats {
  meanEmitIntervalMs: number;
  p95EmitIntervalMs: number;
  meanSourceLagMs: number;
  p95SourceLagMs: number;
}

interface DecoderMetricsProps {
  metricsVx: number;
  metricsVy: number;
  displayConfidence: number;
  clickActive: boolean;
  decoderData: DecoderMetricsPacket | null;
  replayLatencyStats: ReplayLatencyStats | null;
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

function bufferIndicatorClass(bufferSeconds: number | null): string {
  if (bufferSeconds == null) {
    return "border-neutral-700/70 bg-neutral-900/40 text-neutral-300";
  }
  if (bufferSeconds > 15) {
    return "border-emerald-500/35 bg-emerald-500/10 text-emerald-300";
  }
  if (bufferSeconds >= 5) {
    return "border-amber-500/35 bg-amber-500/10 text-amber-300";
  }
  return "border-red-500/35 bg-red-500/10 text-red-300";
}

export function DecoderMetrics({
  metricsVx,
  metricsVy,
  displayConfidence,
  clickActive,
  decoderData,
  replayLatencyStats,
  signalPct,
  signalStyle,
  onResetDecoder,
}: DecoderMetricsProps) {
  const velocityMag = Math.hypot(metricsVx, metricsVy);
  const velocityText = `vx ${metricsVx >= 0 ? "+" : ""}${metricsVx.toFixed(2)}  vy ${
    metricsVy >= 0 ? "+" : ""
  }${metricsVy.toFixed(2)}  |v| ${velocityMag.toFixed(2)}`;
  const confidencePct = Math.round(displayConfidence * 100);
  const decodeLatencyText = decoderData ? `${decoderData.decode_latency_ms.toFixed(0)} ms` : "—";
  const e2eLatencyText = decoderData ? `${decoderData.end_to_end_latency_ms.toFixed(0)} ms` : "—";
  const bufferSeconds = decoderData ? decoderData.redis_buffer_seconds : null;
  const bufferText = bufferSeconds == null ? "Buffer: —" : `Buffer: ${bufferSeconds.toFixed(1)}s`;
  const accuracyText = decoderData ? `${(decoderData.accuracy * 100).toFixed(1)}%` : "—";
  const sessionAccuracyText = decoderData ? `${(decoderData.session_accuracy * 100).toFixed(1)}%` : "—";
  const strengthLabel = signalStrengthLabel(signalPct);
  const clickText = clickActive ? "Click Active" : "Click Idle";
  const clickClass = clickActive ? "text-emerald-300" : "text-neutral-400";

  return (
    <section className="shrink-0 basis-[44%] min-h-0 rounded-xl border border-neutral-800/90 bg-gradient-to-b from-neutral-900/85 to-black/65 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h2 className="text-[10px] font-mono font-semibold uppercase tracking-[0.2em] text-neutral-400">
          Decoder metrics
        </h2>
        <div
          className={`rounded-md border px-2 py-1 text-[10px] font-mono font-semibold tabular-nums ${bufferIndicatorClass(bufferSeconds)}`}
          title="Redis stream buffer horizon"
        >
          {bufferText}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="rounded-lg border border-neutral-800/90 bg-black/35 px-2.5 py-1.5">
          <p className="text-[9px] font-mono uppercase tracking-[0.14em] text-neutral-500">vx / vy / |v|</p>
          <p className="mt-0.5 text-[12px] font-mono font-semibold tracking-tight text-cyan-300 tabular-nums">
            {velocityText}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <div className="rounded-lg border border-neutral-800/90 bg-black/35 px-2 py-1.5">
            <p className="text-[8px] font-mono uppercase tracking-[0.14em] text-neutral-500">Confidence</p>
            <p className="mt-0.5 text-[22px] font-semibold leading-none tracking-tight text-emerald-300 tabular-nums">
              {confidencePct}%
            </p>
          </div>
          <div className="rounded-lg border border-neutral-800/90 bg-black/35 px-2 py-1.5">
            <p className="text-[8px] font-mono uppercase tracking-[0.14em] text-neutral-500">Accuracy</p>
            <div className="mt-0.5 grid grid-cols-1 gap-0.5 text-[10px] font-mono tabular-nums">
              <p className="text-neutral-300">R20 {accuracyText}</p>
              <p className="text-neutral-300">Sess {sessionAccuracyText}</p>
            </div>
          </div>
          <div className="rounded-lg border border-neutral-800/90 bg-black/35 px-2 py-1.5">
            <p className="text-[8px] font-mono uppercase tracking-[0.14em] text-neutral-500">Click</p>
            <p className={`mt-1 text-[11px] font-mono font-semibold ${clickClass}`}>{clickText}</p>
          </div>
        </div>

        <div className="rounded-lg border border-neutral-800/90 bg-black/30 px-2 py-1.5">
          <p className="text-[9px] font-mono uppercase tracking-[0.14em] text-neutral-500">Latencies</p>
          <div className="mt-1 grid grid-cols-3 gap-1 text-[10px] font-mono tabular-nums">
            <div className="rounded border border-neutral-800/70 bg-black/30 px-1.5 py-1">
              <p className="text-neutral-500">Decode</p>
              <p className="text-neutral-200">{decodeLatencyText}</p>
            </div>
            <div className="rounded border border-neutral-800/70 bg-black/30 px-1.5 py-1">
              <p className="text-neutral-500">End-to-end</p>
              <p className="text-neutral-200">{e2eLatencyText}</p>
            </div>
            <div className="rounded border border-neutral-800/70 bg-black/30 px-1.5 py-1">
              <p className="text-neutral-500">Mean emit</p>
              <p className="text-neutral-200">
                {replayLatencyStats ? `${replayLatencyStats.meanEmitIntervalMs.toFixed(2)} ms` : "—"}
              </p>
            </div>
            <div className="rounded border border-neutral-800/70 bg-black/30 px-1.5 py-1">
              <p className="text-neutral-500">P95 emit</p>
              <p className="text-neutral-200">
                {replayLatencyStats ? `${replayLatencyStats.p95EmitIntervalMs.toFixed(2)} ms` : "—"}
              </p>
            </div>
            <div className="rounded border border-neutral-800/70 bg-black/30 px-1.5 py-1">
              <p className="text-neutral-500">Mean source lag</p>
              <p className="text-neutral-200">
                {replayLatencyStats ? `${replayLatencyStats.meanSourceLagMs.toFixed(2)} ms` : "—"}
              </p>
            </div>
            <div className="rounded border border-neutral-800/70 bg-black/30 px-1.5 py-1">
              <p className="text-neutral-500">P95 source lag</p>
              <p className="text-neutral-200">
                {replayLatencyStats ? `${replayLatencyStats.p95SourceLagMs.toFixed(2)} ms` : "—"}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-neutral-800/90 bg-black/30 px-2 py-1">
          <div className="mb-0.5 flex items-center justify-between gap-2">
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
          <p className="mt-0.5 text-[9px] font-mono font-semibold text-neutral-300">{strengthLabel}</p>
        </div>

        <div className="pt-0.5">
          <button
            type="button"
            onClick={onResetDecoder}
            className="w-full rounded-lg border border-neutral-600/80 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-neutral-200 transition-colors hover:bg-neutral-800/80"
          >
            Reset decoder
          </button>
        </div>
      </div>
    </section>
  );
}
