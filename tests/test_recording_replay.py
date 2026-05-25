"""Tests for trackpad recording replay ground truth."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.core.recording_replay import (
    RecordingReplay,
    create_replay_for_demo,
    create_replay_for_recording,
    demo_label_from_id,
    list_demo_recordings,
    list_recordings,
    load_recording_points,
    recording_label_from_id,
    replay_enabled_from_env,
    resample_points_smooth_125hz,
    resolve_recording_file_path,
    resolve_demo_path,
    resolve_recording_path,
    resolve_recording_paths,
    try_create_replay,
    validate_recording_file,
)


def _write_minimal_recording(path: Path, *, n: int = 5) -> None:
    samples = []
    t0 = 1_000_000
    for i in range(n):
        samples.append(
            {
                "x": 0.5 + 0.01 * i,
                "y": 0.5,
                "timestamp_ms": t0 + i * 40,
                "clicked": i == 2,
            }
        )
    path.write_text(
        json.dumps(
            {
                "session_id": "session_test",
                "samples": samples,
            }
        ),
        encoding="utf-8",
    )


def test_load_recording_rebases_time(tmp_path: Path) -> None:
    path = tmp_path / "session_test.json"
    _write_minimal_recording(path)
    session_id, points = load_recording_points(path)
    assert session_id == "session_test"
    assert points[0].t_ms == 0.0
    assert points[-1].t_ms == pytest.approx(160.0)


def test_replay_advances_velocity(tmp_path: Path) -> None:
    path = tmp_path / "session_test.json"
    _write_minimal_recording(path, n=10)
    replay = RecordingReplay([path], batch_ms=20.0)
    f0 = replay.advance(20.0)
    f1 = replay.advance(20.0)
    assert 0.49 <= f0.x <= 0.52
    assert f1.x > f0.x
    assert f0.vx >= 0.0


def test_replay_clicked_flag(tmp_path: Path) -> None:
    path = tmp_path / "session_test.json"
    _write_minimal_recording(path, n=5)
    replay = RecordingReplay([path], batch_ms=20.0)
    frames = [replay.advance(20.0) for _ in range(5)]
    assert any(f.clicked for f in frames)


def test_resolve_paths_explicit(tmp_path: Path) -> None:
    path = tmp_path / "session_a.json"
    _write_minimal_recording(path)
    found = resolve_recording_paths(explicit_path=str(path))
    assert found == [path]


def test_validate_recording_file_accepts_json_name() -> None:
    assert validate_recording_file("session_20250520_143022.json") == "session_20250520_143022.json"


def test_resolve_recording_file_path(tmp_path: Path) -> None:
    path = tmp_path / "session_a.json"
    _write_minimal_recording(path)
    assert resolve_recording_file_path("session_a.json", recordings_dir=tmp_path) == path


def test_try_create_replay_disabled(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    path = tmp_path / "session_a.json"
    _write_minimal_recording(path)
    monkeypatch.setenv("BCI_REPLAY", "0")
    monkeypatch.setenv("BCI_RECORDING_PATH", str(path))
    assert try_create_replay() is None


def test_try_create_replay_from_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    path = tmp_path / "demo_1.json"
    _write_minimal_recording(path)
    monkeypatch.delenv("BCI_REPLAY", raising=False)
    monkeypatch.delenv("BCI_RECORDING_PATH", raising=False)
    monkeypatch.setenv("BCI_RECORDINGS_DIR", str(tmp_path))
    replay = try_create_replay(recordings_dir=tmp_path)
    assert replay is not None
    assert replay.active_recording_id == "demo_1"


def test_replay_enabled_default() -> None:
    assert replay_enabled_from_env() is True


def test_demo_label() -> None:
    assert demo_label_from_id("demo_1") == "Demo 1"
    assert demo_label_from_id("demo_2") == "Demo 2"


def test_session_label() -> None:
    label = recording_label_from_id("session_20260520_012021")
    assert "Session" in label
    assert "2026" in label


def test_list_recordings_includes_sessions(tmp_path: Path) -> None:
    _write_minimal_recording(tmp_path / "demo_1.json")
    _write_minimal_recording(tmp_path / "session_20260520_012021.json")
    items = list_recordings(recordings_dir=tmp_path)
    assert [r.recording_id for r in items] == ["demo_1", "session_20260520_012021"]


def test_list_demo_recordings(tmp_path: Path) -> None:
    for name in ("demo_1", "demo_2"):
        _write_minimal_recording(tmp_path / f"{name}.json")
    demos = list_demo_recordings(recordings_dir=tmp_path)
    assert [d.recording_id for d in demos] == ["demo_1", "demo_2"]


def test_create_replay_for_demo(tmp_path: Path) -> None:
    path = tmp_path / "demo_1.json"
    _write_minimal_recording(path, n=10)
    replay = create_replay_for_demo("demo_1", recordings_dir=tmp_path)
    assert replay.active_recording_id == "demo_1"
    assert resolve_demo_path("demo_1", recordings_dir=tmp_path) == path


def test_create_replay_for_session(tmp_path: Path) -> None:
    path = tmp_path / "session_custom.json"
    _write_minimal_recording(path, n=10)
    replay = create_replay_for_recording("session_custom", recordings_dir=tmp_path)
    assert replay.active_recording_id == "session_custom"
    assert resolve_recording_path("session_custom", recordings_dir=tmp_path) == path


def test_smooth_125hz_resample(tmp_path: Path) -> None:
    path = tmp_path / "session_test.json"
    _write_minimal_recording(path, n=10)
    _, original = load_recording_points(path, timing="original")
    _, smooth = load_recording_points(path, timing="smooth_125hz")
    assert len(smooth) > len(original)
    assert smooth[1].t_ms - smooth[0].t_ms == pytest.approx(8.0)


def test_resample_helper_uniform_step() -> None:
    from app.core.recording_replay import _ReplayPoint

    pts = [
        _ReplayPoint(t_ms=0.0, x=0.0, y=0.5, clicked=False),
        _ReplayPoint(t_ms=40.0, x=1.0, y=0.5, clicked=False),
    ]
    out = resample_points_smooth_125hz(pts)
    assert len(out) >= 5
    assert out[1].t_ms - out[0].t_ms == pytest.approx(8.0)


def test_load_recording_points_fallbacks_to_125hz_on_bad_timestamps(tmp_path: Path) -> None:
    path = tmp_path / "session_test.json"
    path.write_text(
        json.dumps(
            {
                "session_id": "session_test",
                "samples": [
                    {"x": 0.5, "y": 0.5, "timestamp_ms": 1000, "clicked": False},
                    {"x": 0.6, "y": 0.5, "timestamp_ms": 990, "clicked": False},
                    {"x": 0.7, "y": 0.5, "timestamp_ms": 980, "clicked": True},
                ],
            }
        ),
        encoding="utf-8",
    )
    _sid, pts = load_recording_points(path, timing="original")
    assert pts[1].t_ms - pts[0].t_ms == pytest.approx(8.0)
    assert pts[2].t_ms - pts[1].t_ms == pytest.approx(8.0)


def test_next_step_ms_uses_recording_timestamps(tmp_path: Path) -> None:
    path = tmp_path / "session_test.json"
    _write_minimal_recording(path, n=5)
    replay = RecordingReplay([path], batch_ms=20.0, timing="original")
    step = replay.next_step_ms(20.0)
    assert step == pytest.approx(40.0)
    replay.advance(step)
    step2 = replay.next_step_ms(20.0)
    assert step2 == pytest.approx(40.0)
