import time
from collections import deque
from dataclasses import dataclass
from typing import Deque, Literal

import numpy as np
from pydantic import BaseModel, Field
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import LabelEncoder

Intent = Literal["left", "right", "up", "down"]


class DecoderPacket(BaseModel):
    timestamp_ms: float = Field(
        ...,
        description="Unix timestamp in milliseconds since 1970-01-01 UTC (cross-platform epoch time)",
    )
    predicted_intent: Intent
    confidence: float = Field(..., ge=0.0, le=1.0)
    latency_ms: float = Field(..., ge=0.0)
    accuracy: float = Field(..., ge=0.0, le=1.0)


@dataclass(frozen=True)
class _WindowConfig:
    fs: int
    window_ms: int

    @property
    def window_samples(self) -> int:
        return int(round(self.fs * (self.window_ms / 1000.0)))


class BciDecoder:
    """
    Minimal real-time decoder MVP.

    - Features: sliding window spike-rate per channel (spikes/sec).
    - Model: RandomForestClassifier + LabelEncoder.
    - Online operation: maintains a ring buffer of spikes; predicts each packet.

    This class is production-safe in the sense that it:
    - validates shapes defensively
    - has a deterministic model config
    - reports latency and rolling accuracy
    """

    def __init__(self, *, fs: int, channels: int, window_ms: int = 200) -> None:
        if fs <= 0:
            raise ValueError("fs must be positive")
        if channels <= 0:
            raise ValueError("channels must be positive")
        if window_ms <= 0:
            raise ValueError("window_ms must be positive")

        self._cfg = _WindowConfig(fs=fs, window_ms=window_ms)
        self._channels = channels

        self._label_encoder = LabelEncoder()
        self._model = RandomForestClassifier(n_estimators=100, random_state=42)
        self._is_trained = False

        # Sliding window state: (samples_in_batch, channels) int8
        self._spike_window: Deque[np.ndarray] = deque()
        self._window_count = 0

        # Rolling accuracy over last 50 predictions
        self._recent_correct: Deque[int] = deque(maxlen=50)

    @property
    def is_trained(self) -> bool:
        return self._is_trained

    def train(self, X: np.ndarray, y: np.ndarray) -> None:
        """
        Train the model.

        - X: shape (n_samples, n_features) where n_features == channels
        - y: shape (n_samples,) string labels with intents
        """
        if X.ndim != 2:
            raise ValueError("X must be 2D (n_samples, n_features)")
        if X.shape[1] != self._channels:
            raise ValueError(f"X must have n_features == {self._channels}")
        if y.ndim != 1:
            raise ValueError("y must be 1D (n_samples,)")
        if X.shape[0] != y.shape[0]:
            raise ValueError("X and y must have the same number of samples")
        if X.shape[0] < 10:
            raise ValueError("Need at least 10 samples to train")

        y_encoded = self._label_encoder.fit_transform(y)
        self._model.fit(X, y_encoded)
        self._is_trained = True

    def _push_spikes(self, spikes_batch: list[list[int]]) -> None:
        arr = np.asarray(spikes_batch, dtype=np.int8)
        if arr.ndim != 2 or arr.shape[1] != self._channels:
            raise ValueError(
                f"spikes_batch must be 2D with shape (batch_samples, {self._channels})"
            )
        self._spike_window.append(arr)
        self._window_count += int(arr.shape[0])

        # Trim oldest until within window
        while self._window_count > self._cfg.window_samples and self._spike_window:
            oldest = self._spike_window[0]
            overflow = self._window_count - self._cfg.window_samples
            if overflow >= oldest.shape[0]:
                self._spike_window.popleft()
                self._window_count -= int(oldest.shape[0])
                continue
            # Partial trim: drop first overflow samples of oldest batch
            self._spike_window[0] = oldest[overflow:, :]
            self._window_count -= int(overflow)
            break

    def _extract_features(self) -> np.ndarray:
        if self._window_count <= 0:
            return np.zeros((self._channels,), dtype=np.float32)
        window = np.concatenate(list(self._spike_window), axis=0)  # (window_samples, channels)
        # spike rate per channel in spikes/sec
        spikes_per_channel = window.sum(axis=0).astype(np.float32)
        duration_s = float(self._window_count) / float(self._cfg.fs)
        return spikes_per_channel / max(duration_s, 1e-6)

    def _heuristic_predict(self, spike_rates: np.ndarray) -> tuple[Intent, float]:
        """
        Fallback before training: pick the intent whose channel group has highest mean rate.
        Confidence is a squashed margin between top-2 group means.
        """
        groups = {
            "right": spike_rates[0:8],
            "left": spike_rates[8:16],
            "up": spike_rates[16:25],
            "down": spike_rates[25:32],
        }
        means = {k: float(v.mean()) for k, v in groups.items()}
        ranked = sorted(means.items(), key=lambda kv: kv[1], reverse=True)
        best_intent = ranked[0][0]  # type: ignore[assignment]
        best = ranked[0][1]
        second = ranked[1][1]
        margin = max(best - second, 0.0)
        confidence = float(1.0 / (1.0 + np.exp(-margin)))  # sigmoid
        return best_intent, confidence  # type: ignore[return-value]

    def predict(self, spikes_batch: list[list[int]], true_intent: str) -> DecoderPacket:
        """
        Update sliding window with new spikes and return a prediction packet.

        true_intent is used only for rolling accuracy accounting and can be empty/unknown.
        """
        start = time.perf_counter()
        self._push_spikes(spikes_batch)
        feats = self._extract_features().reshape(1, -1)

        if self._is_trained:
            proba = self._model.predict_proba(feats)[0]
            pred_idx = int(np.argmax(proba))
            predicted = str(self._label_encoder.inverse_transform([pred_idx])[0])
            confidence = float(proba[pred_idx])
        else:
            predicted, confidence = self._heuristic_predict(feats[0])

        # rolling accuracy
        if true_intent in ("left", "right", "up", "down"):
            self._recent_correct.append(1 if predicted == true_intent else 0)
        accuracy = float(np.mean(self._recent_correct)) if self._recent_correct else 0.0

        latency_ms = (time.perf_counter() - start) * 1000.0
        return DecoderPacket(
            timestamp_ms=time.time() * 1000.0,
            predicted_intent=predicted,  # type: ignore[arg-type]
            confidence=float(np.clip(confidence, 0.0, 1.0)),
            latency_ms=latency_ms,
            accuracy=accuracy,
        )


def make_bootstrap_training_set(
    *, fs: int, channels: int, window_ms: int = 200, n_per_intent: int = 300, seed: int = 42
) -> tuple[np.ndarray, np.ndarray]:
    """
    Generate a small synthetic training set that matches the simulator's intent biasing.
    Each sample is a per-channel spike-rate vector (spikes/sec) over window_ms.
    """
    rng = np.random.default_rng(seed=seed)
    window_samples = int(round(fs * (window_ms / 1000.0)))
    base_rate_hz = 15.0
    dt = 1.0 / float(fs)
    base_prob = base_rate_hz * dt

    def intent_multiplier(intent: Intent) -> np.ndarray:
        m = np.ones((channels,), dtype=np.float32)
        if intent == "right":
            m[0:8] *= 3.0
        elif intent == "left":
            m[8:16] *= 3.0
        elif intent == "up":
            m[16:25] *= 3.0
        else:  # down
            m[25:32] *= 3.0
        return m

    intents: list[Intent] = ["left", "right", "up", "down"]
    X_list: list[np.ndarray] = []
    y_list: list[str] = []

    for intent in intents:
        m = intent_multiplier(intent)
        prob = np.clip(base_prob * m, 0.0, 0.95)
        for _ in range(n_per_intent):
            spikes = (rng.random((window_samples, channels)) < prob).astype(np.int8)
            spikes_per_channel = spikes.sum(axis=0).astype(np.float32)
            rate = spikes_per_channel / max(window_ms / 1000.0, 1e-6)
            X_list.append(rate)
            y_list.append(intent)

    X = np.stack(X_list, axis=0)
    y = np.asarray(y_list, dtype=object)
    return X, y

