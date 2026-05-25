import pickle
import sys
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Deque, Literal, Tuple, Union

import numpy as np
from pydantic import BaseModel, Field
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.preprocessing import StandardScaler

RegressorKind = Literal["rf", "hgb", "ensemble"]

# Default trained weights relative to repo root (Docker WORKDIR / app cwd). Mount or MODEL_PATH in prod.
MODEL_PATH = "models/velocity_decoder.pkl"

# Per-channel blocks in :func:`compute_window_features`: base 11 + tail(5,10,20) 3 + two deltas 2 + peer corr 1.
FEATURE_GROUPS_PER_CHANNEL = 17

# Blend HGB vs RF in ``ensemble`` mode (higher = trust HGB more for velocity).
ENSEMBLE_HGB_WEIGHT = 0.66


def window_feature_dim(channels: int) -> int:
    """Length of the vector from :func:`compute_window_features` for ``channels`` inputs."""
    return int(channels) * FEATURE_GROUPS_PER_CHANNEL


def map_confidence_display(raw: float) -> float:
    """
    Map internal epistemic confidence ``raw`` in ``[0, 1]`` to a natural-feeling UI range.

    Target band ~0.70–0.96 while preserving ordering (stronger internal scores → higher UI).
    """
    r = float(np.clip(raw, 0.0, 1.0))
    return float(np.clip(0.725 + 0.225 * (r**0.50), 0.70, 0.96))

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
VELOCITY_EMA_ALPHA = 0.22
# Trees used for prediction spread → confidence (cap for latency on large forests).
CONFIDENCE_TREE_SAMPLE = 64
# Click threshold on smoothed speed (keyboard select): below this ⇒ "lifted".
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
        description="True when decoded speed implies a key select / click (keyboard mode).",
    )
    confidence: float = Field(..., ge=0.0, le=1.0)
    decode_latency_ms: float = Field(
        ...,
        ge=0.0,
        description="Pure decoder inference latency in milliseconds (perf_counter around predict path).",
    )
    end_to_end_latency_ms: float = Field(
        ...,
        ge=0.0,
        description="Backend-side packet age in milliseconds from simulator packet timestamp to WS emit.",
    )
    redis_buffer_seconds: float = Field(
        0.0,
        ge=0.0,
        description=(
            "Approximate buffered horizon available in Redis stream seconds "
            "(newest timestamp - oldest timestamp)."
        ),
    )
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


class DecoderResetEvent(BaseModel):
    """Out-of-band WebSocket event — tells the dashboard to clear canvas and metrics."""

    type: Literal["decoder_reset"] = "decoder_reset"
    timestamp_ms: float = Field(
        ...,
        description="Unix timestamp in milliseconds when reset was applied on the server.",
    )
    cursor_x: float = Field(0.5, ge=0.0, le=1.0)
    cursor_y: float = Field(0.5, ge=0.0, le=1.0)
    num_channels: int = Field(..., ge=1)


DecoderWireMessage = Union[DecoderPacket, DecoderResetEvent]


@dataclass(frozen=True)
class _WindowConfig:
    fs: int
    window_ms: int

    @property
    def window_samples(self) -> int:
        return int(round(self.fs * (self.window_ms / 1000.0)))


def _quarter_bin_rates(window: np.ndarray, *, fs: int, channels: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Four equal-time bin mean rates (4, C) Hz and deltas (q2-q1),(q3-q2),(q4-q3) each (C,)."""
    t = int(window.shape[0])
    if t <= 0:
        zb = np.zeros((4, channels), dtype=np.float32)
        zd = np.zeros((3 * channels,), dtype=np.float32)
        return zb, zd, zb.reshape(-1)
    edges = np.linspace(0, t, 5, dtype=np.int64)
    rates_bins = np.zeros((4, channels), dtype=np.float32)
    for k in range(4):
        lo, hi = int(edges[k]), int(edges[k + 1])
        hi = max(lo + 1, hi)
        sl = window[lo:hi]
        dur_s = float(hi - lo) / float(fs)
        rates_bins[k] = sl.sum(axis=0).astype(np.float32) / max(dur_s, 1e-6)
    d12 = rates_bins[1] - rates_bins[0]
    d23 = rates_bins[2] - rates_bins[1]
    d34 = rates_bins[3] - rates_bins[2]
    deltas = np.concatenate([d12, d23, d34], axis=0)
    flat_bins = rates_bins.reshape(-1)
    return rates_bins, deltas, flat_bins


def _ring_neighbor_correlations(window: np.ndarray, *, channels: int) -> np.ndarray:
    """Pearson corr between each channel and its ring successor over time, shape (C,)."""
    out = np.zeros((channels,), dtype=np.float32)
    t = int(window.shape[0])
    if t < 3 or channels < 2:
        return out
    w = window.astype(np.float64)
    for i in range(channels):
        a = w[:, i]
        b = w[:, (i + 1) % channels]
        sa, sb = float(a.std()), float(b.std())
        if sa < 1e-9 or sb < 1e-9:
            continue
        with np.errstate(divide="ignore", invalid="ignore"):
            cij = np.corrcoef(a, b)[0, 1]
        if np.isfinite(cij):
            out[i] = float(np.clip(cij, -1.0, 1.0))
    return out


def _tail_step_rates(
    window: np.ndarray,
    *,
    fs: int,
    channels: int,
    tail_steps: tuple[int, ...] = (5, 10, 20),
) -> np.ndarray:
    """Per-channel mean spike rate (Hz) over the last ``k`` samples for each ``k`` in ``tail_steps``."""
    t = int(window.shape[0])
    if t <= 0:
        return np.zeros((len(tail_steps) * channels,), dtype=np.float32)
    parts: list[np.ndarray] = []
    for k in tail_steps:
        kk = min(int(k), t)
        sl = window[-kk:]
        dur_s = kk / float(fs)
        parts.append(sl.sum(axis=0).astype(np.float32) / max(dur_s, 1e-6))
    return np.concatenate(parts, axis=0).astype(np.float32)


def _delta_rate_last10_vs_prev10(window: np.ndarray, *, fs: int, channels: int) -> np.ndarray:
    t = int(window.shape[0])
    if t < 20:
        return np.zeros((channels,), dtype=np.float32)
    seg = 10 / float(fs)
    r_last = window[-10:].sum(axis=0).astype(np.float32) / max(seg, 1e-6)
    r_prev = window[-20:-10].sum(axis=0).astype(np.float32) / max(seg, 1e-6)
    return (r_last - r_prev).astype(np.float32)


def _delta_rate_last5_vs_first5(window: np.ndarray, *, fs: int, channels: int) -> np.ndarray:
    t = int(window.shape[0])
    if t < 10:
        return np.zeros((channels,), dtype=np.float32)
    seg = 5 / float(fs)
    lo = window[:5].sum(axis=0).astype(np.float32) / max(seg, 1e-6)
    hi = window[-5:].sum(axis=0).astype(np.float32) / max(seg, 1e-6)
    return (hi - lo).astype(np.float32)


def _peer_mean_correlations(window: np.ndarray, *, channels: int) -> np.ndarray:
    """Mean Pearson correlation of each channel with all others (diagonal excluded)."""
    t = int(window.shape[0])
    if t < 8 or channels < 2:
        return np.zeros((channels,), dtype=np.float32)
    w = window.astype(np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        R = np.corrcoef(w.T)
    R = np.nan_to_num(R, nan=0.0, posinf=0.0, neginf=0.0)
    np.fill_diagonal(R, 0.0)
    denom = float(max(channels - 1, 1))
    row = R.sum(axis=0) / denom
    return np.clip(row, -1.0, 1.0).astype(np.float32)


def compute_window_features(
    window: np.ndarray, *, fs: int, window_count: int, channels: int
) -> np.ndarray:
    """
    Map a binary spike window ``(T, C)`` to a fixed-length raw feature vector (``17 × C``).

    Includes: baseline temporal stats, quarter history, ring coupling, **last 5/10/20 step**
    firing rates, **short-horizon rate deltas**, and **mean pairwise channel correlations**.
    Training / inference apply :class:`~sklearn.preprocessing.StandardScaler` in
    :meth:`BciDecoder.train` for zero-mean unit-variance normalization.
    """
    out_dim = window_feature_dim(channels)
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
    _, quarter_deltas, quarter_flat = _quarter_bin_rates(window, fs=fs, channels=channels)
    neigh_corr = _ring_neighbor_correlations(window, channels=channels)
    tail_rates = _tail_step_rates(window, fs=fs, channels=channels)
    d10 = _delta_rate_last10_vs_prev10(window, fs=fs, channels=channels)
    d5 = _delta_rate_last5_vs_first5(window, fs=fs, channels=channels)
    peer = _peer_mean_correlations(window, channels=channels)
    return np.concatenate(
        [
            rates,
            var,
            early_late,
            quarter_flat,
            quarter_deltas,
            neigh_corr,
            tail_rates,
            d10,
            d5,
            peer,
        ],
        axis=0,
    ).astype(np.float32)


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
    # Stronger directional gain so channel populations track (vx, vy) more clearly.
    m = 1.0 + 3.35 * np.clip(align, 0.0, 1.0) * drive
    if not pen_down:
        m *= 0.42
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
    Real-time velocity decoder: rich spike-window features (scaled), then RF, dual HGB,
    or an **RF + HGB ensemble** for ``(vx, vy)``.

    Confidence combines tree / boosting epistemic spread with prediction-interval width,
    then maps to a natural UI band (~0.70–0.95). Velocity is lightly EMA-smoothed for stability.
    """

    def __init__(
        self,
        *,
        fs: int,
        channels: int,
        window_ms: int = 200,
        exploration_prob: float = 0.08,
        cursor_smooth_alpha: float = 0.18,
        regressor: RegressorKind = "ensemble",
    ) -> None:
        if fs <= 0:
            raise ValueError("fs must be positive")
        if channels <= 0:
            raise ValueError("channels must be positive")
        if window_ms <= 0:
            raise ValueError("window_ms must be positive")

        self._cfg = _WindowConfig(fs=fs, window_ms=window_ms)
        self._channels = channels
        self._n_features = window_feature_dim(channels)
        self._regressor_kind: RegressorKind = regressor

        self._model: RandomForestRegressor | None = None
        self._hgb_x: HistGradientBoostingRegressor | None = None
        self._hgb_y: HistGradientBoostingRegressor | None = None

        hgb_kw = dict(
            max_iter=520,
            max_depth=24,
            learning_rate=0.05,
            min_samples_leaf=2,
            l2_regularization=0.03,
            early_stopping=True,
            validation_fraction=0.1,
            n_iter_no_change=32,
            random_state=42,
        )

        if regressor == "ensemble":
            self._model = RandomForestRegressor(
                n_estimators=320,
                max_depth=24,
                min_samples_leaf=2,
                max_features="sqrt",
                random_state=42,
                n_jobs=-1,
            )
            self._hgb_x = HistGradientBoostingRegressor(**hgb_kw)
            self._hgb_y = HistGradientBoostingRegressor(**hgb_kw)
        elif regressor == "hgb":
            self._hgb_x = HistGradientBoostingRegressor(**hgb_kw)
            self._hgb_y = HistGradientBoostingRegressor(**hgb_kw)
        else:
            self._model = RandomForestRegressor(
                n_estimators=400,
                max_depth=25,
                min_samples_leaf=2,
                max_features="sqrt",
                random_state=42,
                n_jobs=-1,
            )

        self._feature_scaler = StandardScaler()
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
    def regressor_kind(self) -> RegressorKind:
        return self._regressor_kind

    @property
    def n_features(self) -> int:
        return self._n_features

    @property
    def window_ms(self) -> int:
        return self._cfg.window_ms

    def train(self, X: np.ndarray, y: np.ndarray) -> None:
        """
        Train regressors on standardized features.

        X: shape (n_samples, n_features) with n_features == 17 × channels (raw features).
        y: shape (n_samples, 2) columns [vx, vy] each in [-1, 1].
        """
        if X.ndim != 2:
            raise ValueError("X must be 2D (n_samples, n_features)")
        if X.shape[1] != self._n_features:
            raise ValueError(f"X must have n_features == {self._n_features} (17 × channels)")
        if y.ndim != 2 or y.shape[1] != 2:
            raise ValueError("y must be 2D (n_samples, 2) with columns [vx, vy]")
        if X.shape[0] != y.shape[0]:
            raise ValueError("X and y must have the same number of samples")
        if X.shape[0] < 10:
            raise ValueError("Need at least 10 samples to train")

        self._feature_scaler.fit(X.astype(np.float64))
        Xs = self._feature_scaler.transform(X.astype(np.float64)).astype(np.float32)
        y64 = y.astype(np.float64)

        if self._regressor_kind == "ensemble":
            if self._model is None or self._hgb_x is None or self._hgb_y is None:
                raise RuntimeError("Ensemble models not initialized")
            self._model.fit(Xs, y64)
            self._hgb_x.fit(Xs, y64[:, 0])
            self._hgb_y.fit(Xs, y64[:, 1])
            n_est = int(len(self._model.estimators_))
            k = min(CONFIDENCE_TREE_SAMPLE, n_est)
            self._tree_indices = (
                np.arange(n_est, dtype=np.int64)
                if k == n_est
                else np.random.default_rng(7).choice(n_est, size=k, replace=False)
            )
        elif self._regressor_kind == "hgb":
            if self._hgb_x is None or self._hgb_y is None:
                raise RuntimeError("HGB models not initialized")
            self._hgb_x.fit(Xs, y64[:, 0])
            self._hgb_y.fit(Xs, y64[:, 1])
            self._tree_indices = None
        else:
            if self._model is None:
                raise RuntimeError("RF model not initialized")
            self._model.fit(Xs, y64)
            n_est = int(len(self._model.estimators_))
            k = min(CONFIDENCE_TREE_SAMPLE, n_est)
            self._tree_indices = (
                np.arange(n_est, dtype=np.int64)
                if k == n_est
                else np.random.default_rng(7).choice(n_est, size=k, replace=False)
            )
        self._is_trained = True

    def predict_velocity(self, features_scaled: np.ndarray, *, raw: np.ndarray | None = None) -> Tuple[float, float]:
        """
        Predict continuous ``(vx, vy)`` in ``[-1, 1]``.

        When trained, ``features_scaled`` is the standardized feature vector. When not trained,
        pass ``raw`` unscaled features and ignore scaled input for the heuristic path.
        """
        fs = np.asarray(features_scaled, dtype=np.float32).ravel()
        if fs.shape[0] != self._n_features:
            raise ValueError(f"features must have length {self._n_features}")

        if not self._is_trained:
            if raw is None:
                raise ValueError("raw features required when decoder is untrained")
            return self._heuristic_velocity(np.asarray(raw, dtype=np.float32).ravel())

        feats = fs.reshape(1, -1)
        if self._regressor_kind == "ensemble":
            if self._model is None or self._hgb_x is None or self._hgb_y is None:
                raise RuntimeError("Ensemble models not initialized")
            rf = self._model.predict(feats)[0]
            hvx = float(self._hgb_x.predict(feats)[0])
            hvy = float(self._hgb_y.predict(feats)[0])
            w = ENSEMBLE_HGB_WEIGHT
            raw_vx = w * hvx + (1.0 - w) * float(rf[0])
            raw_vy = w * hvy + (1.0 - w) * float(rf[1])
        elif self._regressor_kind == "hgb":
            if self._hgb_x is None or self._hgb_y is None:
                raise RuntimeError("HGB models not initialized")
            raw_vx = float(self._hgb_x.predict(feats)[0])
            raw_vy = float(self._hgb_y.predict(feats)[0])
        else:
            if self._model is None:
                raise RuntimeError("RF model not initialized")
            raw = self._model.predict(feats)[0]
            raw_vx, raw_vy = float(raw[0]), float(raw[1])
        vx = float(np.clip(raw_vx, -1.0, 1.0))
        vy = float(np.clip(raw_vy, -1.0, 1.0))
        return vx, vy

    def _regression_confidence(self, feats_scaled_2d: np.ndarray) -> float:
        """Epistemic raw confidence in ``[0, 1]``, then mapped to ~0.70–0.95 for UX."""
        if not self._is_trained:
            return map_confidence_display(0.5)
        if self._regressor_kind == "ensemble":
            raw = self._ensemble_confidence_raw(feats_scaled_2d)
        elif self._regressor_kind == "hgb":
            raw = self._hgb_confidence_raw(feats_scaled_2d)
        else:
            raw = self._rf_confidence_raw(feats_scaled_2d)
        return map_confidence_display(raw)

    def _rf_tree_predictions(self, feats_2d: np.ndarray) -> np.ndarray | None:
        if self._model is None or self._tree_indices is None:
            return None
        preds: list[np.ndarray] = []
        for idx in self._tree_indices:
            preds.append(self._model.estimators_[int(idx)].predict(feats_2d)[0])
        return np.stack(preds, axis=0)

    def _rf_confidence_raw(self, feats_2d: np.ndarray) -> float:
        stacked = self._rf_tree_predictions(feats_2d)
        if stacked is None or stacked.shape[0] < 2:
            return 0.48
        std_vx = float(np.std(stacked[:, 0]))
        std_vy = float(np.std(stacked[:, 1]))
        spread = float(np.hypot(std_vx, std_vy))
        iv_x = float(np.percentile(stacked[:, 0], 90) - np.percentile(stacked[:, 0], 10))
        iv_y = float(np.percentile(stacked[:, 1], 90) - np.percentile(stacked[:, 1], 10))
        interval = 0.5 * (iv_x + iv_y)
        mean_var = float(np.mean(np.var(stacked, axis=0)))
        u_interval = float(interval / (interval + 0.14))
        u_spread = float(np.sqrt(max(mean_var, 0.0)))
        uncertainty = 0.38 * spread + 0.32 * u_interval + 0.30 * u_spread
        return float(np.clip(1.0 / (1.0 + 2.55 * uncertainty), 0.0, 1.0))

    @staticmethod
    def _staged_axis_uncertainty_raw(est: HistGradientBoostingRegressor, feats_2d: np.ndarray) -> float:
        traj = [float(np.ravel(p)[0]) for p in est.staged_predict(feats_2d)]
        arr = np.asarray(traj, dtype=np.float64)
        if arr.size < 4:
            return 0.38
        spread = float(np.std(arr))
        mean_var = float(np.sqrt(max(float(np.var(arr)), 0.0)))
        return 0.62 * spread + 0.38 * mean_var

    def _hgb_confidence_raw(self, feats_2d: np.ndarray) -> float:
        if self._hgb_x is None or self._hgb_y is None:
            return 0.48
        u = 0.5 * (
            self._staged_axis_uncertainty_raw(self._hgb_x, feats_2d)
            + self._staged_axis_uncertainty_raw(self._hgb_y, feats_2d)
        )
        return float(np.clip(1.0 / (1.0 + 2.65 * u), 0.0, 1.0))

    def _ensemble_confidence_raw(self, feats_2d: np.ndarray) -> float:
        rf_r = self._rf_confidence_raw(feats_2d)
        hgb_r = self._hgb_confidence_raw(feats_2d)
        combined = 1.0 - float(np.sqrt(max((1.0 - rf_r) * (1.0 - hgb_r), 0.0)))
        return float(np.clip(0.5 * combined + 0.5 * max(rf_r, hgb_r), 0.0, 1.0))

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

    def _extract_raw_features(self) -> np.ndarray:
        if self._window_count <= 0:
            return np.zeros((self._n_features,), dtype=np.float32)
        window = np.concatenate(list(self._spike_window), axis=0)
        return compute_window_features(
            window, fs=self._cfg.fs, window_count=self._window_count, channels=self._channels
        )

    def _extract_features(self) -> np.ndarray:
        """Feature vector in the same space as training (standardized after fit)."""
        raw = self._extract_raw_features()
        if self._is_trained:
            return self._feature_scaler.transform(raw.reshape(1, -1)).astype(np.float32).ravel()
        return raw.astype(np.float32)

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
    ) -> DecoderPacket:
        start = time.perf_counter()
        self._push_spikes(spikes_batch)
        raw = self._extract_raw_features()
        if self._is_trained:
            scaled = self._feature_scaler.transform(raw.reshape(1, -1)).astype(np.float32).ravel()
        else:
            scaled = raw.astype(np.float32)

        self._predict_step += 1
        if self._predict_step % 50 == 0:
            fv = scaled if self._is_trained else raw
            print(
                f"[decoder] step={self._predict_step} features (n={int(fv.shape[0])}) "
                f"min={float(fv.min()):.4f} max={float(fv.max()):.4f} mean={float(fv.mean()):.4f} "
                f"first12={np.array2string(fv[:12], precision=4, max_line_width=120)}"
            )

        raw_vx, raw_vy = self.predict_velocity(scaled, raw=raw.astype(np.float32))
        feats_scaled_2d = scaled.reshape(1, -1)
        if self._is_trained:
            confidence = self._regression_confidence(feats_scaled_2d)
        else:
            confidence = map_confidence_display(
                float(np.clip(0.35 + 0.45 * min(1.0, np.hypot(raw_vx, raw_vy)), 0.0, 1.0))
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
            decode_latency_ms=latency_ms,
            end_to_end_latency_ms=latency_ms,
            redis_buffer_seconds=0.0,
            accuracy=accuracy,
            session_accuracy=session_accuracy,
            cursor_x=cx,
            cursor_y=cy,
            num_channels=self._channels,
        )

    def reset(self) -> None:
        """Clear spike window, rolling accuracy, velocity smoothers, and cursor integration."""
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
        print(
            "[decoder] reset(): spike window, velocity history, cursor, and session scores cleared"
        )

    def reset_state(self) -> None:
        """Backward-compatible alias for :meth:`reset`."""
        self.reset()

    def build_reset_event(self, *, num_channels: int) -> DecoderResetEvent:
        """Wire payload broadcast to decoder WebSocket clients after :meth:`reset`."""
        return DecoderResetEvent(
            timestamp_ms=time.time() * 1000.0,
            cursor_x=float(self._cursor_x_s),
            cursor_y=float(self._cursor_y_s),
            num_channels=int(num_channels),
        )


def generate_training_data(
    *,
    fs: int,
    channels: int,
    window_ms: int = 200,
    n_samples: int = 150_000,
    seed: int = 42,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Synthetic (vx, vy) regression targets aligned with ``velocity_spike_multipliers``.

    Each row of X is the ``17 × channels`` **raw** feature vector from
    :func:`compute_window_features` (tail-window rates, pairwise correlation summaries,
    rate deltas, quarter history, etc.). :meth:`BciDecoder.train` fits a
    :class:`~sklearn.preprocessing.StandardScaler` on X before fitting regressors.
    Spike statistics mirror the live simulator (speed-dependent gain on multipliers).
    """
    rng = np.random.default_rng(seed=seed)
    window_samples = int(round(fs * (window_ms / 1000.0)))
    base_rate_hz = 17.5
    dt = 1.0 / float(fs)
    base_prob = base_rate_hz * dt

    X_list: list[np.ndarray] = []
    y_list: list[tuple[float, float]] = []

    for _ in range(n_samples):
        # Mixture: dwell near rest, otherwise random direction + speed (continuous control).
        if rng.random() < 0.2:
            vx = float(rng.normal(0.0, 0.1))
            vy = float(rng.normal(0.0, 0.1))
        else:
            ang = float(rng.uniform(-np.pi, np.pi))
            mag = float(rng.uniform(0.22, 1.0))
            vx = float(np.clip(mag * np.cos(ang), -1.0, 1.0))
            vy = float(np.clip(mag * np.sin(ang), -1.0, 1.0))

        pen_down = bool(rng.random() < 0.8) if float(np.hypot(vx, vy)) >= 0.08 else bool(
            rng.random() < 0.32
        )

        speed = float(np.hypot(vx, vy))
        m = velocity_spike_multipliers(vx, vy, pen_down, channels)
        m = m * float(1.0 + 0.28 * min(speed, 1.0))
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
    n_samples: int = 150_000,
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


def default_decoder_artifact_path() -> Path:
    """Default pickle path at repo root (written by ``python -m app.core.offline_eval --retrain``)."""
    return Path(__file__).resolve().parent.parent.parent / MODEL_PATH


def velocity_decoder_missing_help(path: Path) -> str:
    """Explain missing weights for operators (local file, volume mount, or train)."""
    print(
        "[decoder] Trained model missing or Git LFS pointer not materialized.",
        file=sys.stderr,
        flush=True,
    )
    return (
        f"Velocity decoder weights are missing or not materialized at '{path}'. "
        f"Expected file: `{MODEL_PATH}`. "
        "Docker: mount `./models` to `/app/models` (see docker-compose.yml) or set "
        "`MODEL_PATH` / `DECODER_MODEL_PATH`. "
        "If the file is a Git LFS pointer: `git lfs pull` at repo root. "
        "To train locally: `python -m app.core.offline_eval --retrain --artifact models/velocity_decoder.pkl`."
    )


def _path_is_git_lfs_pointer(path: Path) -> bool:
    try:
        head = path.read_bytes()[:200]
    except OSError:
        return False
    return head.startswith(b"version https://git-lfs.github.com/spec/v1")


def save_decoder_artifact(decoder: BciDecoder, path: str | Path) -> None:
    """Persist trained sklearn estimators, scaler, and shape metadata for :func:`load_decoder_artifact_into`."""
    if not decoder.is_trained:
        raise ValueError("Decoder has no trained weights to save")
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    kind = decoder.regressor_kind
    if kind == "rf":
        body: dict[str, object] = {
            "regressor": "rf",
            "model": decoder._model,
            "tree_indices": decoder._tree_indices,
        }
    elif kind == "hgb":
        body = {
            "regressor": "hgb",
            "hgb_x": decoder._hgb_x,
            "hgb_y": decoder._hgb_y,
        }
    else:
        body = {
            "regressor": "ensemble",
            "model": decoder._model,
            "hgb_x": decoder._hgb_x,
            "hgb_y": decoder._hgb_y,
            "tree_indices": decoder._tree_indices,
        }
    payload = {
        **body,
        "scaler": decoder._feature_scaler,
        "channels": decoder._channels,
        "fs": decoder._cfg.fs,
        "window_ms": decoder._cfg.window_ms,
        "n_features": decoder._n_features,
    }
    with p.open("wb") as f:
        pickle.dump(payload, f)


def load_decoder_artifact_into(decoder: BciDecoder, path: str | Path) -> None:
    """Load weights produced by :func:`save_decoder_artifact` into an existing decoder instance."""
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(velocity_decoder_missing_help(p))
    if _path_is_git_lfs_pointer(p):
        raise FileNotFoundError(velocity_decoder_missing_help(p))
    with p.open("rb") as f:
        payload = pickle.load(f)
    if int(payload.get("n_features", -1)) != decoder._n_features:
        raise ValueError(
            f"Artifact n_features={payload.get('n_features')} incompatible with decoder "
            f"(expected {decoder._n_features})"
        )
    if int(payload.get("channels", -1)) != decoder._channels:
        raise ValueError("Artifact channel count does not match decoder")
    kind: str = str(payload.get("regressor", "rf"))
    if kind != decoder.regressor_kind:
        raise ValueError(
            f"Artifact regressor={kind!r} but decoder was constructed with {decoder.regressor_kind!r}"
        )
    scaler = payload.get("scaler")
    if scaler is not None:
        decoder._feature_scaler = scaler  # type: ignore[assignment]
    if kind == "rf":
        if decoder._model is None:
            raise RuntimeError("RF decoder missing model slot")
        decoder._model = payload["model"]  # type: ignore[assignment]
        decoder._tree_indices = payload.get("tree_indices")
        assert decoder._model is not None
        n_est = int(len(decoder._model.estimators_))
        if decoder._tree_indices is None:
            k = min(CONFIDENCE_TREE_SAMPLE, n_est)
            decoder._tree_indices = (
                np.arange(n_est, dtype=np.int64)
                if k == n_est
                else np.random.default_rng(7).choice(n_est, size=k, replace=False)
            )
    elif kind == "ensemble":
        if decoder._model is None or decoder._hgb_x is None or decoder._hgb_y is None:
            raise RuntimeError("Ensemble decoder missing estimators")
        decoder._model = payload["model"]  # type: ignore[assignment]
        decoder._hgb_x = payload["hgb_x"]  # type: ignore[assignment]
        decoder._hgb_y = payload["hgb_y"]  # type: ignore[assignment]
        decoder._tree_indices = payload.get("tree_indices")
        assert decoder._model is not None
        n_est = int(len(decoder._model.estimators_))
        if decoder._tree_indices is None:
            k = min(CONFIDENCE_TREE_SAMPLE, n_est)
            decoder._tree_indices = (
                np.arange(n_est, dtype=np.int64)
                if k == n_est
                else np.random.default_rng(7).choice(n_est, size=k, replace=False)
            )
    else:
        if decoder._hgb_x is None or decoder._hgb_y is None:
            raise RuntimeError("HGB decoder missing estimators")
        decoder._hgb_x = payload["hgb_x"]  # type: ignore[assignment]
        decoder._hgb_y = payload["hgb_y"]  # type: ignore[assignment]
    decoder._is_trained = True
