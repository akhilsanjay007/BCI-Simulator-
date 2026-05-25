"""Replay trackpad recordings as simulator ground truth (velocity + pen_down)."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal

import numpy as np

from app.core.decoder import CURSOR_MAX_SPEED_PER_S

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_RECORDINGS_DIR = REPO_ROOT / "recordings"

# Match simulator batch cadence: fs=1000, batch_size=fs//50 → 20 ms
DEFAULT_BATCH_MS = 20.0
SMOOTH_125HZ_STEP_MS = 8.0
FALLBACK_125HZ_STEP_MS = 8.0

ReplayTiming = Literal["original", "smooth_125hz"]

_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")


@dataclass(frozen=True)
class RecordingInfo:
    """Metadata for a selectable ``recordings/*.json`` file."""

    recording_id: str
    label: str
    typed_text: str
    duration_ms: int
    sample_count: int


# Backward-compatible alias
DemoRecordingInfo = RecordingInfo


@dataclass(frozen=True)
class ReplayFrame:
    """Ground-truth state for one simulator batch."""

    x: float
    y: float
    clicked: bool
    vx: float
    vy: float


@dataclass(frozen=True)
class _ReplayPoint:
    t_ms: float
    x: float
    y: float
    clicked: bool


def replay_enabled_from_env() -> bool:
    """Return False only when ``BCI_REPLAY=0`` / ``false`` / ``off``."""
    raw = os.environ.get("BCI_REPLAY", "").strip().lower()
    if raw in ("0", "false", "no", "off", "disabled"):
        return False
    return True


def recordings_root(recordings_dir: Path | None = None) -> Path:
    dir_env = os.environ.get("BCI_RECORDINGS_DIR", "").strip()
    if recordings_dir is not None:
        return recordings_dir
    return Path(dir_env) if dir_env else DEFAULT_RECORDINGS_DIR


def validate_recording_id(recording_id: str) -> str:
    cleaned = recording_id.strip()
    if not _ID_RE.fullmatch(cleaned):
        raise ValueError(f"Invalid recording id: {recording_id!r}")
    return cleaned


def validate_recording_file(recording_file: str) -> str:
    """Validate a recording filename like ``session_20250520_143022.json``."""
    cleaned = recording_file.strip()
    if not cleaned.lower().endswith(".json"):
        raise ValueError(f"Recording file must end with .json: {recording_file!r}")
    name = Path(cleaned).name
    stem = name[:-5]
    validate_recording_id(stem)
    if name != cleaned:
        raise ValueError(f"Recording file must not include directories: {recording_file!r}")
    return name


def recording_id_from_path(path: Path) -> str:
    return path.stem


def demo_label_from_id(demo_id: str) -> str:
    """``demo_1`` → ``Demo 1``."""
    suffix = demo_id.removeprefix("demo_").replace("_", " ")
    return f"Demo {suffix}" if suffix else demo_id


def recording_label_from_id(recording_id: str) -> str:
    if recording_id.startswith("demo_"):
        return demo_label_from_id(recording_id)
    if recording_id.startswith("session_"):
        rest = recording_id.removeprefix("session_")
        parts = rest.split("_")
        if len(parts) >= 1 and len(parts[0]) == 8:
            try:
                dt = datetime.strptime(parts[0], "%Y%m%d")
                label = f"Session {dt.strftime('%b %d, %Y')}"
                if len(parts) >= 2 and len(parts[1]) == 6:
                    t = parts[1]
                    label += f" {t[:2]}:{t[2:4]}"
                return label
            except ValueError:
                pass
    return recording_id.replace("_", " ")


def list_recording_paths(*, recordings_dir: Path | None = None) -> list[Path]:
    """All ``*.json`` under recordings — demos first, then sessions newest-first."""
    root = recordings_root(recordings_dir)
    if not root.is_dir():
        return []
    paths = [p for p in root.glob("*.json") if p.is_file()]
    demos = sorted(p for p in paths if p.stem.startswith("demo_"))
    others = sorted(
        (p for p in paths if p not in demos),
        key=lambda p: p.stem,
        reverse=True,
    )
    return demos + others


def list_demo_paths(*, recordings_dir: Path | None = None) -> list[Path]:
    """Sorted ``demo_*.json`` files (legacy helper)."""
    return [p for p in list_recording_paths(recordings_dir=recordings_dir) if p.stem.startswith("demo_")]


def resolve_recording_path(
    recording_id: str,
    *,
    recordings_dir: Path | None = None,
) -> Path:
    """Resolve ``demo_1`` / ``session_*`` → ``recordings/{id}.json`` (must exist)."""
    cleaned = validate_recording_id(recording_id)
    root = recordings_root(recordings_dir)
    path = (root / f"{cleaned}.json").resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Recording not found: {cleaned}")
    try:
        path.relative_to(root.resolve())
    except ValueError as e:
        raise FileNotFoundError(f"Recording not found: {cleaned}") from e
    return path


def resolve_recording_file_path(
    recording_file: str,
    *,
    recordings_dir: Path | None = None,
) -> Path:
    """Resolve ``recordings/<recording_file>`` where file is ``*.json``."""
    filename = validate_recording_file(recording_file)
    root = recordings_root(recordings_dir)
    path = (root / filename).resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Recording not found: {filename}")
    try:
        path.relative_to(root.resolve())
    except ValueError as e:
        raise FileNotFoundError(f"Recording not found: {filename}") from e
    return path


def resolve_demo_path(demo_id: str, *, recordings_dir: Path | None = None) -> Path:
    return resolve_recording_path(demo_id, recordings_dir=recordings_dir)


def validate_demo_id(demo_id: str) -> str:
    return validate_recording_id(demo_id)


def list_recordings(*, recordings_dir: Path | None = None) -> list[RecordingInfo]:
    """Load metadata for each ``recordings/*.json`` (no sample payload)."""
    out: list[RecordingInfo] = []
    for path in list_recording_paths(recordings_dir=recordings_dir):
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
        rid = recording_id_from_path(path)
        out.append(
            RecordingInfo(
                recording_id=rid,
                label=recording_label_from_id(rid),
                typed_text=str(data.get("typed_text", "")),
                duration_ms=int(data.get("duration_ms", 0)),
                sample_count=int(data.get("sample_count", 0)),
            )
        )
    return out


def list_demo_recordings(*, recordings_dir: Path | None = None) -> list[RecordingInfo]:
    """Legacy: metadata for ``demo_*.json`` only."""
    return [r for r in list_recordings(recordings_dir=recordings_dir) if r.recording_id.startswith("demo_")]


def resolve_recording_paths(
    *,
    recordings_dir: Path | None = None,
    explicit_path: str | None = None,
) -> list[Path]:
    """Pick JSON files to replay (explicit path, else first demo, else newest session)."""
    if explicit_path:
        path = Path(explicit_path)
        if not path.is_file():
            raise FileNotFoundError(f"BCI_RECORDING_PATH not found: {path}")
        return [path]

    paths = list_recording_paths(recordings_dir=recordings_dir)
    if paths:
        return [paths[0]]
    return []


def _interp_points_at(
    pts: list[_ReplayPoint],
    t_ms: float,
) -> tuple[float, float, bool]:
    if t_ms <= pts[0].t_ms:
        p = pts[0]
        return p.x, p.y, p.clicked
    if t_ms >= pts[-1].t_ms:
        p = pts[-1]
        return p.x, p.y, p.clicked

    lo = 0
    hi = len(pts) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if pts[mid].t_ms <= t_ms:
            lo = mid
        else:
            hi = mid
    a, b = pts[lo], pts[hi]
    span = max(b.t_ms - a.t_ms, 1e-6)
    frac = float(np.clip((t_ms - a.t_ms) / span, 0.0, 1.0))
    x = (1.0 - frac) * a.x + frac * b.x
    y = (1.0 - frac) * a.y + frac * b.y
    clicked = a.clicked or b.clicked
    return float(x), float(y), clicked


def resample_points_smooth_125hz(points: list[_ReplayPoint]) -> list[_ReplayPoint]:
    """Uniform 8 ms spacing for steadier replay when source timestamps are irregular."""
    if len(points) < 2:
        return points
    duration = points[-1].t_ms
    if duration <= 0:
        return points
    out: list[_ReplayPoint] = []
    t = 0.0
    while t <= duration + 1e-6:
        x, y, clicked = _interp_points_at(points, t)
        out.append(_ReplayPoint(t_ms=t, x=x, y=y, clicked=clicked))
        t += SMOOTH_125HZ_STEP_MS
    return out


def load_recording_points(
    path: Path,
    *,
    timing: ReplayTiming = "original",
) -> tuple[str, list[_ReplayPoint]]:
    """Load normalized cursor samples; timestamps rebased to 0 ms."""
    with path.open(encoding="utf-8") as f:
        data = json.load(f)
    session_id = str(data.get("session_id", path.stem))
    raw_samples = data.get("samples")
    if not isinstance(raw_samples, list) or len(raw_samples) < 2:
        raise ValueError(f"Recording has too few samples: {path}")

    t0 = float(raw_samples[0]["timestamp_ms"])
    points: list[_ReplayPoint] = []
    prev_t_ms = -1.0
    invalid_timestamps = False
    for s in raw_samples:
        t_ms = float(s["timestamp_ms"]) - t0
        if not np.isfinite(t_ms) or t_ms < prev_t_ms:
            invalid_timestamps = True
        points.append(
            _ReplayPoint(
                t_ms=t_ms,
                x=float(np.clip(float(s["x"]), 0.0, 1.0)),
                y=float(np.clip(float(s["y"]), 0.0, 1.0)),
                clicked=bool(s.get("clicked", False)),
            )
        )
        prev_t_ms = t_ms
    if invalid_timestamps or points[-1].t_ms <= 0.0:
        # Fallback for malformed/non-monotonic timestamps: enforce 125 Hz timing.
        points = [
            _ReplayPoint(
                t_ms=i * FALLBACK_125HZ_STEP_MS,
                x=p.x,
                y=p.y,
                clicked=p.clicked,
            )
            for i, p in enumerate(points)
        ]
    if timing == "smooth_125hz":
        points = resample_points_smooth_125hz(points)
    return session_id, points


class RecordingReplay:
    """
    Time-warped replay of one or more saved trackpad sessions.

    Advances on each simulator batch; loops the current session, then cycles files.
    """

    def __init__(
        self,
        paths: list[Path],
        *,
        batch_ms: float = DEFAULT_BATCH_MS,
        timing: ReplayTiming = "original",
    ) -> None:
        if not paths:
            raise ValueError("RecordingReplay requires at least one recording path")
        self._batch_ms = float(batch_ms)
        self._paths = list(paths)
        self._timing = timing
        self._recording_id = recording_id_from_path(paths[0]) if len(paths) == 1 else None
        self._sessions: list[tuple[str, list[_ReplayPoint]]] = [
            load_recording_points(p, timing=timing) for p in paths
        ]
        self._session_idx = 0
        self._points = self._sessions[0][1]
        self._point_times = np.asarray([p.t_ms for p in self._points], dtype=np.float64)
        self._duration_ms = self._points[-1].t_ms
        self._elapsed_ms = 0.0
        self._prev_x = self._points[0].x
        self._prev_y = self._points[0].y
        self._prev_t_ms = self._points[0].t_ms
        self._paused = False
        self._speed = 1.0
        self.session_id = self._sessions[0][0]

    @property
    def active(self) -> bool:
        return True

    @property
    def paused(self) -> bool:
        return self._paused

    @property
    def speed(self) -> float:
        return self._speed

    @property
    def duration_ms(self) -> float:
        return float(self._duration_ms)

    @property
    def elapsed_ms(self) -> float:
        return float(self._elapsed_ms)

    @property
    def progress(self) -> float:
        if self._duration_ms <= 1e-6:
            return 0.0
        return float(np.clip(self._elapsed_ms / self._duration_ms, 0.0, 1.0))

    def _load_session(self, idx: int) -> None:
        self._session_idx = idx % len(self._sessions)
        self.session_id, self._points = self._sessions[self._session_idx]
        self._point_times = np.asarray([p.t_ms for p in self._points], dtype=np.float64)
        self._duration_ms = self._points[-1].t_ms
        self._elapsed_ms = 0.0
        self._prev_x = self._points[0].x
        self._prev_y = self._points[0].y
        self._prev_t_ms = self._points[0].t_ms

    def restart(self) -> None:
        """Rewind the current session to t=0 (used when switching recordings)."""
        self._load_session(self._session_idx)
        self._paused = False

    def play(self) -> None:
        self._paused = False

    def pause(self) -> None:
        self._paused = True

    def set_speed(self, speed: float) -> None:
        self._speed = float(np.clip(speed, 0.25, 3.0))

    def seek_progress(self, progress: float) -> None:
        """Seek current session by normalized progress in [0, 1]."""
        frac = float(np.clip(progress, 0.0, 1.0))
        self._elapsed_ms = frac * self._duration_ms
        x, y, _clicked = self._sample_at(self._elapsed_ms)
        self._prev_x, self._prev_y = x, y
        self._prev_t_ms = self._elapsed_ms

    @property
    def active_recording_id(self) -> str | None:
        return self._recording_id

    @property
    def active_demo_id(self) -> str | None:
        """Legacy alias — same as ``active_recording_id`` when a single file is loaded."""
        return self._recording_id

    def _interp_at(self, t_ms: float) -> tuple[float, float, bool]:
        return _interp_points_at(self._points, t_ms)

    def _sample_at(self, t_ms: float) -> tuple[float, float, bool]:
        if self._timing != "original":
            return self._interp_at(t_ms)
        idx = int(np.searchsorted(self._point_times, t_ms, side="right") - 1)
        idx = int(np.clip(idx, 0, len(self._points) - 1))
        p = self._points[idx]
        return p.x, p.y, p.clicked

    def next_step_ms(self, default_ms: float) -> float:
        """Recommended real-time step to follow recording timestamps smoothly."""
        if self._paused:
            return float(max(default_ms, 1.0))
        idx = int(np.searchsorted(self._point_times, self._elapsed_ms, side="right"))
        if idx >= len(self._point_times):
            return float(max(default_ms, 1.0))
        step = float(self._point_times[idx] - self._elapsed_ms)
        if not np.isfinite(step) or step <= 0.5:
            return float(max(default_ms, 1.0))
        return float(np.clip(step, 1.0, 250.0))

    def advance(self, dt_ms: float | None = None) -> ReplayFrame:
        """Step replay clock and return ground-truth cursor + velocity for this batch."""
        step = self._batch_ms if dt_ms is None else float(dt_ms)
        effective_step = step * self._speed
        if not self._paused:
            self._elapsed_ms += effective_step

        if self._elapsed_ms > self._duration_ms:
            next_idx = (self._session_idx + 1) % len(self._sessions)
            self._load_session(next_idx)

        x, y, clicked = self._sample_at(self._elapsed_ms)
        dt_ms = max(self._elapsed_ms - self._prev_t_ms, effective_step)
        dt_s = max(dt_ms / 1000.0, 1e-6)
        if self._paused:
            vx = 0.0
            vy = 0.0
        else:
            scale = max(CURSOR_MAX_SPEED_PER_S, 1e-6)
            vx = float(np.clip((x - self._prev_x) / dt_s / scale, -1.0, 1.0))
            vy = float(np.clip((y - self._prev_y) / dt_s / scale, -1.0, 1.0))
        self._prev_x, self._prev_y = x, y
        self._prev_t_ms = self._elapsed_ms
        return ReplayFrame(x=x, y=y, clicked=clicked, vx=vx, vy=vy)


def create_replay_for_recording(
    recording_id: str,
    *,
    recordings_dir: Path | None = None,
    batch_ms: float = DEFAULT_BATCH_MS,
    timing: ReplayTiming = "original",
) -> RecordingReplay:
    path = resolve_recording_path(recording_id, recordings_dir=recordings_dir)
    return RecordingReplay([path], batch_ms=batch_ms, timing=timing)


def create_replay_for_demo(
    demo_id: str,
    *,
    recordings_dir: Path | None = None,
    batch_ms: float = DEFAULT_BATCH_MS,
    timing: ReplayTiming = "original",
) -> RecordingReplay:
    return create_replay_for_recording(
        demo_id,
        recordings_dir=recordings_dir,
        batch_ms=batch_ms,
        timing=timing,
    )


def try_create_replay(
    *,
    recordings_dir: Path | None = None,
    batch_ms: float = DEFAULT_BATCH_MS,
    timing: ReplayTiming = "original",
) -> RecordingReplay | None:
    """Construct replay driver when enabled and recordings exist."""
    if not replay_enabled_from_env():
        return None
    explicit = os.environ.get("BCI_RECORDING_PATH", "").strip() or None
    rec_dir = recordings_dir
    try:
        if explicit is None:
            try:
                demo_path = resolve_recording_file_path("demo_1.json", recordings_dir=rec_dir)
                paths = [demo_path]
            except FileNotFoundError:
                paths = resolve_recording_paths(recordings_dir=rec_dir, explicit_path=explicit)
        else:
            paths = resolve_recording_paths(recordings_dir=rec_dir, explicit_path=explicit)
    except FileNotFoundError:
        raise
    if not paths:
        return None
    return RecordingReplay(paths, batch_ms=batch_ms, timing=timing)
