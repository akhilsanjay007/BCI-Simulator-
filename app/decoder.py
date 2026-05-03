import time
from collections import deque
from dataclasses import dataclass
from typing import Deque, Literal

import numpy as np
from pydantic import BaseModel, Field
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import LabelEncoder

Intent = Literal["left", "right", "up", "down", "rest"]

# Must match app.main._step_cursor integration so off-line cursor matches live semantics.
CURSOR_SPEED_PER_S = 0.85

# When max class probability or top-1 vs top-2 margin is too small, treat as "rest"
# (suppress twitchy direction picks on ambiguous windows).
REST_GATE_MIN_TOP_PROBA = 0.38
REST_GATE_MIN_MARGIN = 0.09

# Slightly sharpen RF probabilities for reported confidence (spread-preserving, same argmax).
CONFIDENCE_SHARPEN_GAMMA = 1.28


class DecoderPacket(BaseModel):
    timestamp_ms: float = Field(
        ...,
        description="Unix timestamp in milliseconds since 1970-01-01 UTC (cross-platform epoch time)",
    )
    predicted_intent: Intent
    confidence: float = Field(..., ge=0.0, le=1.0)
    latency_ms: float = Field(..., ge=0.0)
    accuracy: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Rolling accuracy over the last 20 predictions (vs true_intent).",
    )
    session_accuracy: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Fraction correct since connect or last reset_state().",
    )
    cursor_x: float = Field(
        0.5,
        ge=0.0,
        le=1.0,
        description="Normalized horizontal cursor position [0,1] in the 2D control plane; server integrates intent.",
    )
    cursor_y: float = Field(
        0.5,
        ge=0.0,
        le=1.0,
        description="Normalized vertical cursor position [0,1] in the 2D control plane; server integrates intent.",
    )


@dataclass(frozen=True)
class _WindowConfig:
    fs: int
    window_ms: int

    @property
    def window_samples(self) -> int:
        return int(round(self.fs * (self.window_ms / 1000.0)))


def compute_window_features(
    window: np.ndarray, *, fs: int, window_count: int, channels: int
) -> np.ndarray:
    """
    Map a binary spike window (T, C) to a fixed-length feature vector.

    Per channel we use:
    - mean spike rate (Hz) over the full window
    - time-series variance of binary spikes (temporal "burstiness")
    - early-vs-late rate difference (Hz): simple temporal asymmetry cue
    """
    out_dim = channels * 3
    if window.size == 0 or window_count <= 0:
        return np.zeros((out_dim,), dtype=np.float32)
    window = np.asarray(window, dtype=np.int8)
    if window.ndim != 2 or window.shape[1] != channels:
        raise ValueError(f"window must be (T, {channels})")
    t = int(window.shape[0])
    duration_s = float(window_count) / float(fs)
    rates = window.sum(axis=0).astype(np.float32) / max(duration_s, 1e-6)
    var = window.astype(np.float32).var(axis=0)
    mid = max(t // 2, 1)
    dur1 = mid / float(fs)
    dur2 = (t - mid) / float(fs)
    r1 = window[:mid].sum(axis=0).astype(np.float32) / max(dur1, 1e-6)
    r2 = window[mid:].sum(axis=0).astype(np.float32) / max(dur2, 1e-6)
    early_late = r2 - r1
    return np.concatenate([rates, var, early_late], axis=0).astype(np.float32)


class BciDecoder:
    """
    Real-time decoder with rich spike-window features and a RandomForestClassifier.

    Features (per channel × 3): spike rate, spike variance, early-vs-late rate delta.
    Exploration (~8% default) keeps the policy from freezing; optional uncertainty gating
    maps ambiguous windows to "rest".

    Cursor: integrates predicted intent with the same speed as app.main, then applies
    exponential smoothing on cursor_x/cursor_y. Note: the live /ws/decoder path may still
    overwrite cursor fields in main.py — smoothing remains correct for offline use and API
    consumers that forward DecoderPacket unchanged.
    """

    def __init__(
        self,
        *,
        fs: int,
        channels: int,
        window_ms: int = 200,
        exploration_prob: float = 0.08,
        cursor_smooth_alpha: float = 0.35,
    ) -> None:
        if fs <= 0:
            raise ValueError("fs must be positive")
        if channels <= 0:
            raise ValueError("channels must be positive")
        if window_ms <= 0:
            raise ValueError("window_ms must be positive")

        self._cfg = _WindowConfig(fs=fs, window_ms=window_ms)
        self._channels = channels
        self._n_features = channels * 3

        self._label_encoder = LabelEncoder()
        self._model = RandomForestClassifier(
            n_estimators=280,
            max_depth=18,
            min_samples_leaf=2,
            max_features="sqrt",
            random_state=42,
            n_jobs=-1,
            class_weight="balanced_subsample",
        )
        self._is_trained = False

        self._spike_window: Deque[np.ndarray] = deque()
        self._window_count = 0

        self._recent_correct: Deque[int] = deque(maxlen=20)
        self._session_correct = 0
        self._session_total = 0
        self._predict_step = 0
        self._explore_rng = np.random.default_rng(seed=123)
        self._explore_prob = exploration_prob

        # Raw + exponentially smoothed cursor (normalized [0,1]).
        self._cursor_x_raw = 0.5
        self._cursor_y_raw = 0.5
        self._cursor_x_s = 0.5
        self._cursor_y_s = 0.5
        self._cursor_smooth_alpha = float(np.clip(cursor_smooth_alpha, 0.01, 1.0))

    @property
    def is_trained(self) -> bool:
        return self._is_trained

    @property
    def n_features(self) -> int:
        return self._n_features

    def train(self, X: np.ndarray, y: np.ndarray) -> None:
        """
        Train the forest.

        X: shape (n_samples, n_features) with n_features == 3 * channels (stacked:
           rates || per-channel variance || early-vs-late delta).
        y: shape (n_samples,) string labels.
        """
        if X.ndim != 2:
            raise ValueError("X must be 2D (n_samples, n_features)")
        if X.shape[1] != self._n_features:
            raise ValueError(f"X must have n_features == {self._n_features} (3 × channels)")
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

        while self._window_count > self._cfg.window_samples and self._spike_window:
            oldest = self._spike_window[0]
            overflow = self._window_count - self._cfg.window_samples
            if overflow >= oldest.shape[0]:
                self._spike_window.popleft()
                self._window_count -= int(oldest.shape[0])
                continue
            self._spike_window[0] = oldest[overflow:, :]
            self._window_count -= int(overflow)
            break

    def _extract_features(self) -> np.ndarray:
        if self._window_count <= 0:
            return np.zeros((self._n_features,), dtype=np.float32)
        window = np.concatenate(list(self._spike_window), axis=0)
        return compute_window_features(
            window, fs=self._cfg.fs, window_count=self._window_count, channels=self._channels
        )

    def _sharpen_proba(self, proba: np.ndarray) -> np.ndarray:
        """Increase peakiness for confidence display (renormalized)."""
        p = np.maximum(proba.astype(np.float64), 1e-12)
        p = np.power(p, CONFIDENCE_SHARPEN_GAMMA)
        p /= p.sum()
        return p

    def _postprocess_sklearn(
        self, proba: np.ndarray
    ) -> tuple[str, float]:
        """
        Choose intent from forest probabilities with an uncertainty gate toward 'rest'.
        """
        classes = self._label_encoder.classes_
        sharp = self._sharpen_proba(proba)
        order = np.argsort(sharp)[::-1]
        i1, i2 = int(order[0]), int(order[1]) if len(order) > 1 else int(order[0])
        top_p = float(sharp[i1])
        second_p = float(sharp[i2])
        margin = top_p - second_p
        best = str(classes[i1])

        # If model already prefers rest with reasonable support, keep it.
        if best == "rest":
            return "rest", float(np.clip(top_p, 0.0, 1.0))

        # Ambiguous directional vote → rest (reduces accidental nudges).
        if top_p < REST_GATE_MIN_TOP_PROBA or margin < REST_GATE_MIN_MARGIN:
            return "rest", float(np.clip(0.55 + 0.35 * (1.0 - top_p), 0.0, 1.0))

        return best, float(np.clip(top_p, 0.0, 1.0))

    def _heuristic_predict(self, feats: np.ndarray) -> tuple[Intent, float]:
        """
        Pre-training fallback: use only the per-channel rate slice (first C dims)
        and compare directional channel groups (matches simulator layout).
        """
        spike_rates = feats[: self._channels]
        groups = {
            "right": spike_rates[0:8],
            "left": spike_rates[8:16],
            "up": spike_rates[16:25],
            "down": spike_rates[25:32],
        }
        means = {k: float(v.mean()) for k, v in groups.items()}
        vals = list(means.values())
        spread = max(vals) - min(vals)
        mean_rate = float(np.mean(vals))
        # Low contrast across groups ⇒ idle / rest-like activity.
        if spread < max(0.18 * max(mean_rate, 1e-3), 1.2):
            return "rest", 0.58
        ranked = sorted(means.items(), key=lambda kv: kv[1], reverse=True)
        best_intent = ranked[0][0]
        best = ranked[0][1]
        second = ranked[1][1]
        margin = max(best - second, 0.0)
        confidence = float(1.0 / (1.0 + np.exp(-0.35 * margin)))
        return best_intent, confidence  # type: ignore[return-value]

    def _step_cursor(self, intent: str, batch_samples: int) -> tuple[float, float, float, float]:
        """Integrate intent into raw cursor, then update exponentially smoothed positions."""
        if batch_samples <= 0:
            return (
                float(self._cursor_x_s),
                float(self._cursor_y_s),
                float(self._cursor_x_raw),
                float(self._cursor_y_raw),
            )

        dt_s = batch_samples / float(self._cfg.fs)
        step = CURSOR_SPEED_PER_S * dt_s
        x, y = self._cursor_x_raw, self._cursor_y_raw

        if intent == "right":
            x += step
        elif intent == "left":
            x -= step
        elif intent == "up":
            y -= step
        elif intent == "down":
            y += step
        # rest: hold position (still smoothed toward that hold).

        x = float(np.clip(x, 0.0, 1.0))
        y = float(np.clip(y, 0.0, 1.0))
        self._cursor_x_raw, self._cursor_y_raw = x, y

        a = self._cursor_smooth_alpha
        self._cursor_x_s = a * x + (1.0 - a) * self._cursor_x_s
        self._cursor_y_s = a * y + (1.0 - a) * self._cursor_y_s
        return float(self._cursor_x_s), float(self._cursor_y_s), x, y

    def predict(self, spikes_batch: list[list[int]], true_intent: str) -> DecoderPacket:
        start = time.perf_counter()
        self._push_spikes(spikes_batch)
        feats = self._extract_features().reshape(1, -1)
        self._predict_step += 1
        if self._predict_step % 50 == 0:
            fv = feats[0]
            print(
                f"[decoder] step={self._predict_step} features (n={int(fv.shape[0])}) "
                f"min={float(fv.min()):.4f} max={float(fv.max()):.4f} mean={float(fv.mean()):.4f} "
                f"first12={np.array2string(fv[:12], precision=4, max_line_width=120)}"
            )

        if self._is_trained:
            proba = self._model.predict_proba(feats)[0]
            predicted, confidence = self._postprocess_sklearn(proba)
        else:
            predicted, confidence = self._heuristic_predict(feats[0])

        if self._explore_rng.random() < self._explore_prob:
            if self._is_trained:
                pool = [str(c) for c in self._label_encoder.classes_ if str(c) != predicted]
            else:
                pool = [i for i in ("left", "right", "up", "down", "rest") if i != predicted]
            if pool:
                predicted = str(self._explore_rng.choice(pool))
                # Exploration stays visibly uncertain but not as noisy as wide uniform draws.
                confidence = float(self._explore_rng.uniform(0.18, 0.48))

        if true_intent in ("left", "right", "up", "down", "rest"):
            self._recent_correct.append(1 if predicted == true_intent else 0)
            self._session_total += 1
            if predicted == true_intent:
                self._session_correct += 1
        accuracy = float(np.mean(self._recent_correct)) if self._recent_correct else 0.0
        session_accuracy = (
            float(self._session_correct) / float(self._session_total)
            if self._session_total
            else 0.0
        )

        if self._predict_step % 50 == 0 and true_intent in ("left", "right", "up", "down", "rest"):
            print(
                f"[decoder] step={self._predict_step} predicted={predicted} true={true_intent}"
            )

        batch_samples = len(spikes_batch)
        cx, cy, _, _ = self._step_cursor(predicted, batch_samples)

        latency_ms = (time.perf_counter() - start) * 1000.0
        return DecoderPacket(
            timestamp_ms=time.time() * 1000.0,
            predicted_intent=predicted,  # type: ignore[arg-type]
            confidence=float(np.clip(confidence, 0.0, 1.0)),
            latency_ms=latency_ms,
            accuracy=accuracy,
            session_accuracy=session_accuracy,
            cursor_x=cx,
            cursor_y=cy,
        )

    def reset_state(self) -> None:
        """Clear sliding window, accuracy buffer, and cursor state."""
        self._spike_window.clear()
        self._window_count = 0
        self._recent_correct.clear()
        self._session_correct = 0
        self._session_total = 0
        self._predict_step = 0
        self._cursor_x_raw = 0.5
        self._cursor_y_raw = 0.5
        self._cursor_x_s = 0.5
        self._cursor_y_s = 0.5


def make_bootstrap_training_set(
    *, fs: int, channels: int, window_ms: int = 200, n_per_intent: int = 300, seed: int = 42
) -> tuple[np.ndarray, np.ndarray]:
    """
    Synthetic training data aligned with the simulator's spatial intent maps.

    Each row is the same 3×channel feature vector used online (rates, variance, early-late).
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
        elif intent == "down":
            m[25:32] *= 3.0
        else:  # rest — uniform baseline
            pass
        return m

    intents: list[Intent] = ["left", "right", "up", "down", "rest"]
    X_list: list[np.ndarray] = []
    y_list: list[str] = []

    for intent in intents:
        m = intent_multiplier(intent)
        prob = np.clip(base_prob * m, 0.0, 0.95)
        for _ in range(n_per_intent):
            spikes = (rng.random((window_samples, channels)) < prob).astype(np.int8)
            feats = compute_window_features(
                spikes, fs=fs, window_count=window_samples, channels=channels
            )
            X_list.append(feats)
            y_list.append(intent)

    X = np.stack(X_list, axis=0)
    y = np.asarray(y_list, dtype=object)
    return X, y
