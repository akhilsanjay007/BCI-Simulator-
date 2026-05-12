"""Offline evaluation of the BCI decoder on synthetic spike batches (no WebSocket).

Used by pytest and for quick sanity checks without running the server.
"""

from __future__ import annotations

import numpy as np

from app.decoder import (
    BciDecoder,
    generate_training_data,
    velocity_spike_multipliers,
)


def velocity_spike_probability(
    vx: float,
    vy: float,
    pen_down: bool,
    *,
    channels: int,
    fs: int,
    base_rate_hz: float = 15.0,
) -> np.ndarray:
    """Per-sample spike probability per channel, aligned with the live simulator."""
    dt = 1.0 / float(fs)
    base_prob = base_rate_hz * dt
    m = velocity_spike_multipliers(vx, vy, pen_down, channels)
    speed = float(np.hypot(vx, vy))
    m = m * float(1.0 + 0.22 * min(speed, 1.0))
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


def evaluate_decoder_offline(
    *,
    fs: int = 1000,
    channels: int = 32,
    window_ms: int = 200,
    batches_per_target: int = 40,
    batch_size: int | None = None,
    train_n_samples: int = 1800,
    seed: int = 42,
) -> dict[str, float | int]:
    """
    Train a fresh decoder on bootstrap regression data, then measure batch-level
    velocity alignment (mean score in [0, 1]) on held-out synthetic spikes.
    """
    if batch_size is None:
        batch_size = fs // 50

    rng = np.random.default_rng(seed)

    decoder = BciDecoder(fs=fs, channels=channels, window_ms=window_ms, exploration_prob=0.0)
    X_train, y_train = generate_training_data(
        fs=fs,
        channels=channels,
        window_ms=window_ms,
        n_samples=train_n_samples,
        seed=seed,
    )
    decoder.train(X_train, y_train)
    decoder.reset_state()

    max_dist = 2.0 * np.sqrt(2.0)
    score_sum = 0.0
    total = 0
    trials = max(1, batches_per_target * 8)

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
        total += 1

    return {
        "accuracy": float(score_sum / float(total)) if total else 0.0,
        "n_samples": total,
    }


def velocity_error_histogram_offline(
    *,
    fs: int = 1000,
    channels: int = 32,
    window_ms: int = 200,
    batches: int = 200,
    batch_size: int | None = None,
    train_n_samples: int = 1800,
    seed: int = 42,
) -> dict[str, float]:
    """Mean L2 velocity error (for quick regression diagnostics)."""
    if batch_size is None:
        batch_size = fs // 50

    rng = np.random.default_rng(seed)
    decoder = BciDecoder(fs=fs, channels=channels, window_ms=window_ms, exploration_prob=0.0)
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


__all__ = [
    "evaluate_decoder_offline",
    "synthetic_spikes_batch",
    "velocity_error_histogram_offline",
    "velocity_spike_probability",
]
