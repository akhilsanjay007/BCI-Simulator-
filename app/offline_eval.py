"""Offline evaluation of the BCI decoder on synthetic spike batches (no WebSocket).

Used by pytest and for quick sanity checks without running the server.
"""

from __future__ import annotations

import numpy as np

from app.decoder import BciDecoder, Intent, make_bootstrap_training_set


def intent_spike_probability(
    intent: Intent,
    *,
    channels: int,
    fs: int,
    base_rate_hz: float = 15.0,
) -> np.ndarray:
    """Per-sample spike probability per channel, aligned with the live simulator."""
    dt = 1.0 / float(fs)
    base_prob = base_rate_hz * dt
    m = np.ones((channels,), dtype=np.float32)
    if intent == "right":
        m[0:8] *= 3.0
    elif intent == "left":
        m[8:16] *= 3.0
    elif intent == "up":
        m[16:25] *= 3.0
    elif intent == "down":
        m[25:32] *= 3.0
    else:  # rest
        pass
    return np.clip(base_prob * m, 0.0, 0.95)


def synthetic_spikes_batch(
    batch_size: int,
    channels: int,
    intent: Intent,
    rng: np.random.Generator,
    *,
    fs: int,
) -> list[list[int]]:
    """One spikes batch `(batch_size, channels)` for the given intended direction."""
    prob = intent_spike_probability(intent, channels=channels, fs=fs)
    p = rng.random((batch_size, channels))
    spikes = (p < prob).astype(np.int8)
    return spikes.tolist()


def evaluate_decoder_offline(
    *,
    fs: int = 1000,
    channels: int = 32,
    window_ms: int = 200,
    batches_per_intent: int = 40,
    batch_size: int | None = None,
    train_n_per_intent: int = 300,
    seed: int = 42,
) -> dict[str, float | int]:
    """
    Train a fresh decoder on bootstrap data, then measure batch-level classification
    accuracy on held-out synthetic spikes (same generative model).
    """
    if batch_size is None:
        batch_size = fs // 50

    rng = np.random.default_rng(seed)

    decoder = BciDecoder(fs=fs, channels=channels, window_ms=window_ms, exploration_prob=0.0)
    X_train, y_train = make_bootstrap_training_set(
        fs=fs,
        channels=channels,
        window_ms=window_ms,
        n_per_intent=train_n_per_intent,
        seed=seed,
    )
    decoder.train(X_train, y_train)
    decoder.reset_state()

    intents: list[Intent] = ["left", "right", "up", "down", "rest"]
    correct = 0
    total = 0
    for true in intents:
        for _ in range(batches_per_intent):
            spikes = synthetic_spikes_batch(batch_size, channels, true, rng, fs=fs)
            pkt = decoder.predict(spikes, true_intent=true)
            if pkt.predicted_intent == true:
                correct += 1
            total += 1

    return {
        "accuracy": float(correct) / float(total) if total else 0.0,
        "n_samples": total,
        "n_correct": correct,
    }


def confusion_counts_offline(
    *,
    fs: int = 1000,
    channels: int = 32,
    window_ms: int = 200,
    batches_per_intent: int = 25,
    batch_size: int | None = None,
    train_n_per_intent: int = 300,
    seed: int = 42,
) -> dict[str, dict[str, int]]:
    """Build a confusion table true_intent -> predicted_intent -> count."""
    if batch_size is None:
        batch_size = fs // 50

    rng = np.random.default_rng(seed)
    decoder = BciDecoder(fs=fs, channels=channels, window_ms=window_ms, exploration_prob=0.0)
    X_train, y_train = make_bootstrap_training_set(
        fs=fs,
        channels=channels,
        window_ms=window_ms,
        n_per_intent=train_n_per_intent,
        seed=seed,
    )
    decoder.train(X_train, y_train)
    decoder.reset_state()

    intents: list[Intent] = ["left", "right", "up", "down", "rest"]
    table: dict[str, dict[str, int]] = {t: {p: 0 for p in intents} for t in intents}
    for true in intents:
        for _ in range(batches_per_intent):
            spikes = synthetic_spikes_batch(batch_size, channels, true, rng, fs=fs)
            pkt = decoder.predict(spikes, true_intent=true)
            table[true][pkt.predicted_intent] += 1
    return table
