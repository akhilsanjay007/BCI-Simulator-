"""Offline evaluation of the BCI decoder on synthetic spike batches (no WebSocket).

Used by pytest and for quick sanity checks without running the server.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from app.decoder import (
    BciDecoder,
    RegressorKind,
    default_decoder_artifact_path,
    generate_training_data,
    save_decoder_artifact,
    velocity_spike_multipliers,
)


def velocity_spike_probability(
    vx: float,
    vy: float,
    pen_down: bool,
    *,
    channels: int,
    fs: int,
    base_rate_hz: float = 17.5,
) -> np.ndarray:
    """Per-sample spike probability per channel, aligned with the live simulator."""
    dt = 1.0 / float(fs)
    base_prob = base_rate_hz * dt
    m = velocity_spike_multipliers(vx, vy, pen_down, channels)
    speed = float(np.hypot(vx, vy))
    m = m * float(1.0 + 0.28 * min(speed, 1.0))
    return np.clip(base_prob * m, 0.0, 0.95)


def synthetic_spikes_batch(
    batch_size: int,
    channels: int,
    vx: float,
    vy: float,
    pen_down: bool,
    rng: np.random.Generator,
    *,
    fs: int,
) -> list[list[int]]:
    """One spikes batch `(batch_size, channels)` for the given velocity target."""
    prob = velocity_spike_probability(vx, vy, pen_down, channels=channels, fs=fs)
    p = rng.random((batch_size, channels))
    spikes = (p < prob).astype(np.int8)
    return spikes.tolist()


def measure_velocity_decoding_performance(
    decoder: BciDecoder,
    *,
    fs: int = 1000,
    channels: int = 32,
    window_ms: int = 200,
    batches_per_target: int = 40,
    batch_size: int | None = None,
    seed: int = 42,
    trials_multiplier: int = 8,
) -> dict[str, float | int]:
    """
    Run synthetic batches through an already-trained decoder (no training step).

    Returns mean velocity-alignment score and mean reported confidence.
    """
    if batch_size is None:
        batch_size = fs // 50

    rng = np.random.default_rng(seed)
    decoder.reset_state()

    max_dist = 2.0 * np.sqrt(2.0)
    score_sum = 0.0
    conf_sum = 0.0
    total = 0
    trials = max(1, batches_per_target * trials_multiplier)

    for _ in range(trials):
        if rng.random() < 0.2:
            vx = float(rng.normal(0.0, 0.1))
            vy = float(rng.normal(0.0, 0.1))
        else:
            ang = float(rng.uniform(-np.pi, np.pi))
            mag = float(rng.uniform(0.2, 1.0))
            vx = float(np.clip(mag * np.cos(ang), -1.0, 1.0))
            vy = float(np.clip(mag * np.sin(ang), -1.0, 1.0))
        pen = bool(rng.random() < 0.75)

        spikes = synthetic_spikes_batch(batch_size, channels, vx, vy, pen, rng, fs=fs)
        pkt = decoder.predict(spikes, true_vx=vx, true_vy=vy, true_pen_down=pen)
        dist = float(np.hypot(pkt.vx - vx, pkt.vy - vy))
        score_sum += float(np.clip(1.0 - dist / max_dist, 0.0, 1.0))
        conf_sum += float(pkt.confidence)
        total += 1

    n = float(total)
    return {
        "accuracy": float(score_sum / n) if total else 0.0,
        "mean_confidence": float(conf_sum / n) if total else 0.0,
        "n_samples": total,
    }


def evaluate_decoder_offline(
    *,
    fs: int = 1000,
    channels: int = 32,
    window_ms: int = 200,
    batches_per_target: int = 40,
    batch_size: int | None = None,
    train_n_samples: int = 1800,
    seed: int = 42,
    regressor: RegressorKind = "rf",
) -> dict[str, float | int]:
    """
    Train a fresh decoder on bootstrap regression data, then measure batch-level
    velocity alignment (mean score in [0, 1]) on held-out synthetic spikes.
    """
    if batch_size is None:
        batch_size = fs // 50

    decoder = BciDecoder(
        fs=fs,
        channels=channels,
        window_ms=window_ms,
        exploration_prob=0.0,
        regressor=regressor,
    )
    X_train, y_train = generate_training_data(
        fs=fs,
        channels=channels,
        window_ms=window_ms,
        n_samples=train_n_samples,
        seed=seed,
    )
    decoder.train(X_train, y_train)

    m = measure_velocity_decoding_performance(
        decoder,
        fs=fs,
        channels=channels,
        window_ms=window_ms,
        batches_per_target=batches_per_target,
        batch_size=batch_size,
        seed=seed + 1,
    )
    return m


def velocity_error_histogram_offline(
    *,
    fs: int = 1000,
    channels: int = 32,
    window_ms: int = 200,
    batches: int = 200,
    batch_size: int | None = None,
    train_n_samples: int = 1800,
    seed: int = 42,
    regressor: RegressorKind = "rf",
) -> dict[str, float]:
    """Mean L2 velocity error (for quick regression diagnostics)."""
    if batch_size is None:
        batch_size = fs // 50

    rng = np.random.default_rng(seed)
    decoder = BciDecoder(
        fs=fs,
        channels=channels,
        window_ms=window_ms,
        exploration_prob=0.0,
        regressor=regressor,
    )
    X_train, y_train = generate_training_data(
        fs=fs,
        channels=channels,
        window_ms=window_ms,
        n_samples=train_n_samples,
        seed=seed,
    )
    decoder.train(X_train, y_train)
    decoder.reset_state()

    err_sum = 0.0
    for _ in range(batches):
        vx = float(rng.uniform(-1.0, 1.0))
        vy = float(rng.uniform(-1.0, 1.0))
        pen = bool(rng.random() < 0.8)
        spikes = synthetic_spikes_batch(batch_size, channels, vx, vy, pen, rng, fs=fs)
        pkt = decoder.predict(spikes, true_vx=vx, true_vy=vy, true_pen_down=pen)
        err_sum += float(np.hypot(pkt.vx - vx, pkt.vy - vy))

    return {"mean_l2_error": err_sum / float(batches) if batches else 0.0}


def _cli_velocity_retrain(args: argparse.Namespace) -> int:
    fs = int(args.fs)
    channels = int(args.channels)
    window_ms = int(args.window_ms)
    samples = int(args.samples)
    m = str(args.model).lower()
    if m == "rf":
        regressor: RegressorKind = "rf"
    elif m == "hgb":
        regressor = "hgb"
    else:
        regressor = "ensemble"

    decoder = BciDecoder(
        fs=fs,
        channels=channels,
        window_ms=window_ms,
        exploration_prob=0.0,
        regressor=regressor,
    )
    print(
        f"Training velocity regressor ({regressor}) on {samples:,} synthetic windows "
        f"({channels} ch @ {fs} Hz, {window_ms} ms)…",
        flush=True,
    )
    X_train, y_train = generate_training_data(
        fs=fs,
        channels=channels,
        window_ms=window_ms,
        n_samples=samples,
        seed=int(args.seed),
    )
    decoder.train(X_train, y_train)

    artifact_path = Path(args.artifact)
    if args.retrain:
        save_decoder_artifact(decoder, artifact_path)
        print(f"Wrote artifact to {artifact_path.resolve()}", flush=True)

    stats = measure_velocity_decoding_performance(
        decoder,
        fs=fs,
        channels=channels,
        window_ms=window_ms,
        batches_per_target=int(args.batches_per_target),
        batch_size=args.batch_size,
        seed=int(args.seed) + 11,
    )
    banner = "=" * 62
    print(banner, flush=True)
    print(f"FINAL MEAN CONFIDENCE: {stats['mean_confidence']:.4f}", flush=True)
    print(
        f"Held-out mean velocity alignment: {stats['accuracy']:.4f} "
        f"({stats['n_samples']} decoder batches)",
        flush=True,
    )
    print(banner, flush=True)
    return 0


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Offline velocity decoder evaluation and optional artifact export.",
    )
    p.add_argument("--mode", default="velocity", choices=["velocity"], help="Evaluation mode.")
    p.add_argument(
        "--samples",
        type=int,
        default=150_000,
        help="Training windows for --retrain (or standalone train+eval).",
    )
    p.add_argument(
        "--retrain",
        action="store_true",
        help="After training, pickle weights to --artifact (default: models/velocity_decoder.pkl).",
    )
    p.add_argument(
        "--artifact",
        type=str,
        default=str(default_decoder_artifact_path()),
        help="Pickle path used with --retrain.",
    )
    p.add_argument(
        "--model",
        choices=["rf", "hgb", "ensemble"],
        default="ensemble",
        help="RandomForest, dual HistGradientBoosting (vx/vy), or RF+HGB ensemble (default).",
    )
    p.add_argument("--fs", type=int, default=1000)
    p.add_argument("--channels", type=int, default=32)
    p.add_argument("--window-ms", type=int, default=200, dest="window_ms")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--batches-per-target", type=int, default=40, dest="batches_per_target")
    p.add_argument("--batch-size", type=int, default=None, dest="batch_size")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    if args.mode == "velocity":
        return _cli_velocity_retrain(args)
    return 1


__all__ = [
    "default_decoder_artifact_path",
    "evaluate_decoder_offline",
    "measure_velocity_decoding_performance",
    "save_decoder_artifact",
    "synthetic_spikes_batch",
    "velocity_error_histogram_offline",
    "velocity_spike_probability",
]


if __name__ == "__main__":
    sys.exit(main())
