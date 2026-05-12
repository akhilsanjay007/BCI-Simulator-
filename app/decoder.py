import time
from collections import deque
from dataclasses import dataclass
from typing import Deque, Literal, Tuple

import numpy as np
from pydantic import BaseModel, Field
from sklearn.ensemble import RandomForestRegressor

DecoderMode = Literal["cursor", "handwriting"]

# Velocity-based cursor: max axis speed (normalized [0,1] plane per second) at full confidence.
CURSOR_MAX_SPEED_PER_S = 0.85
# How quickly actual velocity tracks the commanded velocity (higher = snappier direction changes).
CURSOR_VEL_TRACKING_PER_S = 14.0
# Baseline exponential damping on velocity each step (friction).
CURSOR_VEL_DAMPING_PER_S = 2.0
# Extra damping when the decoded speed is near zero (coast to a stop).
CURSOR_NEAR_ZERO_EXTRA_DAMPING_PER_S = 4.5
# Extra damping scaled by (1 - confidence) so weak predictions bleed off speed.
CURSOR_WEAK_CONF_DAMPING_PER_S = 3.5

# EMA on regressed (vx, vy) before cursor integration (Neuralink-style temporal smoothing).
VELOCITY_EMA_ALPHA = 0.38
# Trees sampled to estimate prediction sharpness → confidence (full forest would be too slow).
CONFIDENCE_TREE_SAMPLE = 32
# Pen-down threshold on smoothed speed (handwriting): below this ⇒ "lifted".
PEN_DOWN_SPEED_THRESHOLD = 0.11


class DecoderPacket(BaseModel):
    """Wire format for `/ws/decoder` — continuous velocity + cursor integration."""

    timestamp_ms: float = Field(
        ...,
        description="Unix timestamp in milliseconds since 1970-01-01 UTC (cross-platform epoch time)",
    )
    vx: float = Field(
        ...,
        ge=-1.0,
        le=1.0,
        description="Decoded horizontal velocity intent in [-1, 1] (normalized).",
    )
    vy: float = Field(
        ...,
        ge=-1.0,
        le=1.0,
        description="Decoded vertical velocity intent in [-1, 1] (normalized; +y is downward).",
    )
    pen_down: bool = Field(
        ...,
        description="True when decoded motion implies contact with the writing surface.",
    )
    confidence: float = Field(..., ge=0.0, le=1.0)
    mode: DecoderMode = Field(
        "cursor",
        description='Output semantics: "cursor" (2D pointer) vs "handwriting" (pen lift).',
    )
    latency_ms: float = Field(..., ge=0.0)
    accuracy: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Rolling score over last 20 batches: 1 - normalized velocity error vs ground truth.",
    )
    session_accuracy: float = Field(
        ...,
        ge=0.0,
        le=1.0,
        description="Mean velocity-alignment score since connect or last reset_state().",
    )
    cursor_x: float = Field(
        0.5,
        ge=0.0,
        le=1.0,
        description="Normalized horizontal cursor position [0,1]; server integrates decoded velocity.",
    )
    cursor_y: float = Field(
        0.5,
        ge=0.0,
        le=1.0,
        description="Normalized vertical cursor position [0,1]; server integrates decoded velocity.",
    )
    num_channels: int = Field(
        ...,
        ge=1,
        description="Number of neural recording channels in the simulator/decoder configuration.",
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


def velocity_spike_multipliers(
    vx: float, vy: float, pen_down: bool, channels: int
) -> np.ndarray:
    """
    Per-channel gains for smooth velocity: each channel prefers motion along a direction
    on the ring ``angle_k = 2π k / C``; firing increases when velocity aligns with that direction.
    """
    if channels < 2:
        return np.ones((channels,), dtype=np.float32)
    speed = float(np.hypot(vx, vy))
    if speed < 1e-9:
        u = np.array([1.0, 0.0], dtype=np.float64)
    else:
        u = np.array([vx / speed, vy / speed], dtype=np.float64)
    idx = np.arange(channels, dtype=np.float64)
    ang = 2.0 * np.pi * idx / float(channels)
    cos_a = np.cos(ang)
    sin_a = np.sin(ang)
    align = (cos_a * u[0] + sin_a * u[1]).astype(np.float32)
    drive = float(min(speed, 1.0))
    m = 1.0 + 2.12 * np.clip(align, 0.0, 1.0) * drive
    if not pen_down:
        m *= 0.5
    return m.astype(np.float32)


def _per_batch_velocity_score(
    pred_vx: float, pred_vy: float, true_vx: float, true_vy: float
) -> float:
    """Scalar in [0, 1]: 1 when predicted velocity matches ground truth."""
    dist = float(np.hypot(pred_vx - true_vx, pred_vy - true_vy))
    max_dist = 2.0 * np.sqrt(2.0)
    return float(np.clip(1.0 - dist / max_dist, 0.0, 1.0))


class BciDecoder:
    """
    Real-time velocity decoder: spike-window features → RandomForestRegressor (vx, vy).

    Applies EMA smoothing and confidence from inter-tree disagreement, then integrates
    a clamped 2D cursor for the dashboard. ``mode`` selects whether pen_down is forced
    on (cursor) or inferred from decoded speed (handwriting).
    """

    def __init__(
        self,
        *,
        fs: int,
        channels: int,
        window_ms: int = 200,
        exploration_prob: float = 0.08,
        cursor_smooth_alpha: float = 0.22,
        output_mode: DecoderMode = "cursor",
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
        self._output_mode: DecoderMode = output_mode

        self._model = RandomForestRegressor(
            n_estimators=280,
            max_depth=18,
            min_samples_leaf=2,
            max_features="sqrt",
            random_state=42,
            n_jobs=-1,
        )
        self._is_trained = False
        self._tree_indices: np.ndarray | None = None

        self._spike_window: Deque[np.ndarray] = deque()
        self._window_count = 0

        self._recent_scores: Deque[float] = deque(maxlen=20)
        self._session_score_sum = 0.0
        self._session_score_count = 0
        self._predict_step = 0
        self._explore_rng = np.random.default_rng(seed=123)
        self._explore_prob = exploration_prob

        self._vx_smooth = 0.0
        self._vy_smooth = 0.0
        self._vel_ema_alpha = float(np.clip(VELOCITY_EMA_ALPHA, 0.01, 1.0))

        self._cursor_x_raw = 0.5
        self._cursor_y_raw = 0.5
        self._cursor_vx = 0.0
        self._cursor_vy = 0.0
        self._cursor_x_s = 0.5
        self._cursor_y_s = 0.5
        self._cursor_smooth_alpha = float(np.clip(cursor_smooth_alpha, 0.01, 1.0))

    @property
    def is_trained(self) -> bool:
        return self._is_trained

    @property
    def n_features(self) -> int:
        return self._n_features

    @property
    def output_mode(self) -> DecoderMode:
        return self._output_mode

    @property
    def window_ms(self) -> int:
        return self._cfg.window_ms

    def set_output_mode(self, mode: DecoderMode) -> None:
        """Switch packet semantics: cursor (pen always down) vs handwriting (pen from speed)."""
        self._output_mode = mode

    def train(self, X: np.ndarray, y: np.ndarray) -> None:
        """
        Train the regressor.

        X: shape (n_samples, n_features) with n_features == 3 * channels.
        y: shape (n_samples, 2) columns [vx, vy] each in [-1, 1].
        """
        if X.ndim != 2:
            raise ValueError("X must be 2D (n_samples, n_features)")
        if X.shape[1] != self._n_features:
            raise ValueError(f"X must have n_features == {self._n_features} (3 × channels)")
        if y.ndim != 2 or y.shape[1] != 2:
            raise ValueError("y must be 2D (n_samples, 2) with columns [vx, vy]")
        if X.shape[0] != y.shape[0]:
            raise ValueError("X and y must have the same number of samples")
        if X.shape[0] < 10:
            raise ValueError("Need at least 10 samples to train")

        self._model.fit(X, y.astype(np.float64))
        n_est = int(len(self._model.estimators_))
        k = min(CONFIDENCE_TREE_SAMPLE, n_est)
        self._tree_indices = (
            np.arange(n_est, dtype=np.int64)
            if k == n_est
            else np.random.default_rng(7).choice(n_est, size=k, replace=False)
        )
        self._is_trained = True

    def predict_velocity(self, features: np.ndarray) -> Tuple[float, float]:
        """
        Predict continuous ``(vx, vy)`` in ``[-1, 1]``.

        ``features`` is a 1D vector of length ``n_features``.
        """
        feats = np.asarray(features, dtype=np.float32).reshape(1, -1)
        if feats.shape[1] != self._n_features:
            raise ValueError(f"features must have length {self._n_features}")

        if self._is_trained:
            raw = self._model.predict(feats)[0]
            vx = float(np.clip(raw[0], -1.0, 1.0))
            vy = float(np.clip(raw[1], -1.0, 1.0))
            return vx, vy
        vx, vy = self._heuristic_velocity(feats[0])
        return vx, vy

    def _regression_confidence(self, feats_2d: np.ndarray) -> float:
        """Higher when tree predictions agree (lower std on vx, vy)."""
        if not self._is_trained or self._tree_indices is None:
            return 0.5
        preds: list[np.ndarray] = []
        for idx in self._tree_indices:
            preds.append(self._model.estimators_[int(idx)].predict(feats_2d)[0])
        stacked = np.stack(preds, axis=0)
        std = float(np.mean(np.std(stacked, axis=0)))
        # std ~ 0 → confident; std large → uncertain
        return float(np.clip(1.0 / (1.0 + 4.2 * std), 0.0, 1.0))

    def _heuristic_velocity(self, feats: np.ndarray) -> tuple[float, float]:
        """Pre-training fallback: circular population coding (matches ring ``velocity_spike_multipliers``)."""
        c = self._channels
        if c < 8:
            return 0.0, 0.0
        spike_rates = feats[:c].astype(np.float64)
        w = spike_rates - float(np.min(spike_rates))
        sum_w = float(np.sum(w))
        if sum_w < 1e-6:
            return 0.0, 0.0
        idx = np.arange(c, dtype=np.float64)
        ang = 2.0 * np.pi * idx / float(c)
        wx = float(np.sum(w * np.cos(ang)) / sum_w)
        wy = float(np.sum(w * np.sin(ang)) / sum_w)
        mag = float(np.hypot(wx, wy))
        if mag < 0.08:
            return 0.0, 0.0
        vx = float(np.clip(wx / mag * min(1.0, mag * 2.4), -1.0, 1.0))
        vy = float(np.clip(wy / mag * min(1.0, mag * 2.4), -1.0, 1.0))
        return vx, vy

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

    def _step_cursor(
        self,
        cmd_vx: float,
        cmd_vy: float,
        confidence: float,
        batch_samples: int,
    ) -> tuple[float, float, float, float]:
        """
        Integrate cursor from decoded velocity command (already smoothed/clipped).
        cmd_* are in [-1, 1]; scaled by CURSOR_MAX_SPEED_PER_S and confidence.
        """
        if batch_samples <= 0:
            return (
                float(self._cursor_x_s),
                float(self._cursor_y_s),
                float(self._cursor_x_raw),
                float(self._cursor_y_raw),
            )

        dt_s = batch_samples / float(self._cfg.fs)
        conf = float(np.clip(confidence, 0.0, 1.0))
        gain = float(conf**0.88)
        speed = float(np.hypot(cmd_vx, cmd_vy))
        target_vx = cmd_vx * CURSOR_MAX_SPEED_PER_S * gain
        target_vy = cmd_vy * CURSOR_MAX_SPEED_PER_S * gain

        k = CURSOR_VEL_TRACKING_PER_S
        self._cursor_vx += k * (target_vx - self._cursor_vx) * dt_s
        self._cursor_vy += k * (target_vy - self._cursor_vy) * dt_s

        damp_total = CURSOR_VEL_DAMPING_PER_S
        if speed < 0.05:
            damp_total += CURSOR_NEAR_ZERO_EXTRA_DAMPING_PER_S
        damp_total += CURSOR_WEAK_CONF_DAMPING_PER_S * float(1.0 - conf)
        damp_factor = float(np.exp(-damp_total * dt_s))
        self._cursor_vx *= damp_factor
        self._cursor_vy *= damp_factor

        x = float(np.clip(self._cursor_x_raw + self._cursor_vx * dt_s, 0.0, 1.0))
        y = float(np.clip(self._cursor_y_raw + self._cursor_vy * dt_s, 0.0, 1.0))
        if x <= 0.0 and self._cursor_vx < 0.0:
            self._cursor_vx = 0.0
        if x >= 1.0 and self._cursor_vx > 0.0:
            self._cursor_vx = 0.0
        if y <= 0.0 and self._cursor_vy < 0.0:
            self._cursor_vy = 0.0
        if y >= 1.0 and self._cursor_vy > 0.0:
            self._cursor_vy = 0.0
        self._cursor_x_raw, self._cursor_y_raw = x, y

        a = self._cursor_smooth_alpha
        self._cursor_x_s = a * x + (1.0 - a) * self._cursor_x_s
        self._cursor_y_s = a * y + (1.0 - a) * self._cursor_y_s
        return float(self._cursor_x_s), float(self._cursor_y_s), x, y

    def predict(
        self,
        spikes_batch: list[list[int]],
        *,
        true_vx: float,
        true_vy: float,
        true_pen_down: bool,
    ) -> DecoderPacket:
        start = time.perf_counter()
        self._push_spikes(spikes_batch)
        feats = self._extract_features()
        self._predict_step += 1
        if self._predict_step % 50 == 0:
            fv = feats
            print(
                f"[decoder] step={self._predict_step} features (n={int(fv.shape[0])}) "
                f"min={float(fv.min()):.4f} max={float(fv.max()):.4f} mean={float(fv.mean()):.4f} "
                f"first12={np.array2string(fv[:12], precision=4, max_line_width=120)}"
            )

        raw_vx, raw_vy = self.predict_velocity(feats)
        feats_2d = np.asarray(feats, dtype=np.float32).reshape(1, -1)
        if self._is_trained:
            confidence = self._regression_confidence(feats_2d)
        else:
            confidence = float(
                np.clip(0.35 + 0.45 * min(1.0, np.hypot(raw_vx, raw_vy)), 0.0, 1.0)
            )

        if self._explore_rng.random() < self._explore_prob:
            raw_vx = float(self._explore_rng.uniform(-1.0, 1.0))
            raw_vy = float(self._explore_rng.uniform(-1.0, 1.0))
            confidence = float(self._explore_rng.uniform(0.2, 0.55))

        a = self._vel_ema_alpha
        self._vx_smooth = a * raw_vx + (1.0 - a) * self._vx_smooth
        self._vy_smooth = a * raw_vy + (1.0 - a) * self._vy_smooth
        vx_out = float(np.clip(self._vx_smooth, -1.0, 1.0))
        vy_out = float(np.clip(self._vy_smooth, -1.0, 1.0))

        if self._output_mode == "cursor":
            pen_down = True
        else:
            pen_down = float(np.hypot(vx_out, vy_out)) >= PEN_DOWN_SPEED_THRESHOLD

        batch_samples = len(spikes_batch)
        cx, cy, _, _ = self._step_cursor(vx_out, vy_out, confidence, batch_samples)

        score = _per_batch_velocity_score(vx_out, vy_out, true_vx, true_vy)
        self._recent_scores.append(score)
        self._session_score_sum += score
        self._session_score_count += 1
        accuracy = float(np.mean(self._recent_scores)) if self._recent_scores else 0.0
        session_accuracy = (
            float(self._session_score_sum / float(self._session_score_count))
            if self._session_score_count
            else 0.0
        )

        if self._predict_step % 50 == 0:
            print(
                f"[decoder] step={self._predict_step} v=({vx_out:+.2f},{vy_out:+.2f}) "
                f"true=({true_vx:+.2f},{true_vy:+.2f}) conf={confidence:.2f}"
            )

        latency_ms = (time.perf_counter() - start) * 1000.0
        return DecoderPacket(
            timestamp_ms=time.time() * 1000.0,
            vx=vx_out,
            vy=vy_out,
            pen_down=pen_down,
            confidence=float(np.clip(confidence, 0.0, 1.0)),
            mode=self._output_mode,
            latency_ms=latency_ms,
            accuracy=accuracy,
            session_accuracy=session_accuracy,
            cursor_x=cx,
            cursor_y=cy,
            num_channels=self._channels,
        )

    def reset_state(self) -> None:
        """Clear sliding window, score buffers, velocity smoothers, and cursor state."""
        self._spike_window.clear()
        self._window_count = 0
        self._recent_scores.clear()
        self._session_score_sum = 0.0
        self._session_score_count = 0
        self._predict_step = 0
        self._vx_smooth = 0.0
        self._vy_smooth = 0.0
        self._cursor_x_raw = 0.5
        self._cursor_y_raw = 0.5
        self._cursor_vx = 0.0
        self._cursor_vy = 0.0
        self._cursor_x_s = 0.5
        self._cursor_y_s = 0.5


def generate_training_data(
    *,
    fs: int,
    channels: int,
    window_ms: int = 200,
    n_samples: int = 1800,
    seed: int = 42,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Synthetic (vx, vy) regression targets aligned with ``velocity_spike_multipliers``.

    Each row of X is the 3×channel feature vector; each row of y is [vx, vy] in [-1, 1].
    """
    rng = np.random.default_rng(seed=seed)
    window_samples = int(round(fs * (window_ms / 1000.0)))
    base_rate_hz = 15.0
    dt = 1.0 / float(fs)
    base_prob = base_rate_hz * dt

    X_list: list[np.ndarray] = []
    y_list: list[tuple[float, float]] = []

    for _ in range(n_samples):
        # Mixture: dwell near rest, otherwise random direction + speed (continuous control).
        if rng.random() < 0.22:
            vx = float(rng.normal(0.0, 0.12))
            vy = float(rng.normal(0.0, 0.12))
        else:
            ang = float(rng.uniform(-np.pi, np.pi))
            mag = float(rng.uniform(0.25, 1.0))
            vx = float(np.clip(mag * np.cos(ang), -1.0, 1.0))
            vy = float(np.clip(mag * np.sin(ang), -1.0, 1.0))

        pen_down = bool(rng.random() < 0.78) if float(np.hypot(vx, vy)) >= 0.08 else bool(
            rng.random() < 0.35
        )

        m = velocity_spike_multipliers(vx, vy, pen_down, channels)
        prob = np.clip(base_prob * m, 0.0, 0.95)
        spikes = (rng.random((window_samples, channels)) < prob).astype(np.int8)
        feats = compute_window_features(
            spikes, fs=fs, window_count=window_samples, channels=channels
        )
        X_list.append(feats)
        y_list.append((vx, vy))

    X = np.stack(X_list, axis=0)
    y = np.asarray(y_list, dtype=np.float32)
    return X, y


def make_bootstrap_training_set(
    *,
    fs: int,
    channels: int,
    window_ms: int = 200,
    n_samples: int = 1800,
    seed: int = 42,
) -> tuple[np.ndarray, np.ndarray]:
    """Backward-compatible alias for :func:`generate_training_data`."""
    return generate_training_data(
        fs=fs,
        channels=channels,
        window_ms=window_ms,
        n_samples=n_samples,
        seed=seed,
    )
