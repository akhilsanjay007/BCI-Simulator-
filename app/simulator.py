"""Synthetic Neuralink-style signal generator (shared by WebSocket streams)."""

from __future__ import annotations

import asyncio
import os
import time
from collections import deque
from typing import Any, Deque, Dict, Literal

import numpy as np
from pydantic import BaseModel, Field

from app.decoder import velocity_spike_multipliers
from app.recording_replay import (
    RecordingReplay,
    ReplayTiming,
    create_replay_for_recording,
    resolve_recording_file_path,
    try_create_replay,
)
from app.redis_client import get_redis_client

# Hold each velocity segment for many batches; within the segment we linearly ramp
# start→end so firing rates change smoothly (continuous trajectory, not step targets).
_VELOCITY_HOLD_BATCHES = 50  # 50 × 20 ms = 1.0 s at fs=1000, batch_size=fs//50


SimulatorMode = Literal["live", "playback"]


class SignalPacket(BaseModel):
    """Typed packet sent over WebSocket — exactly what a real decoder expects."""

    timestamp_ms: float = Field(
        ...,
        description="Unix timestamp in milliseconds since 1970-01-01 UTC (cross-platform epoch time)",
    )
    fs: int = Field(..., description="Sampling rate Hz")
    channels: int = Field(..., description="Number of channels")
    lfp: list[list[float]] = Field(..., description="LFP data [batch_size, channels]")
    spikes: list[list[int]] = Field(..., description="Binary spike events [batch_size, channels]")


class NeuralSignalGenerator:
    """
    Synthetic generator tuned for continuous velocity decoding.

    Uses ring-shaped population coding (each channel prefers a direction on ``2π k / C``)
    and linearly interpolated velocity segments for smooth modulated firing.
    """

    def __init__(self, num_channels: int = 32, fs: int = 1000, base_spike_rate_hz: float = 15.0):
        self.num_channels = num_channels
        self.fs = fs
        self.dt = 1.0 / fs
        self.base_spike_rate = base_spike_rate_hz
        self.rng = np.random.default_rng(seed=42)  # reproducible for demos
        self.freqs = self.rng.uniform(1, 30, num_channels)  # Hz
        self._stream_step = 0
        self._velocity_ring: Deque[tuple[float, float]] = deque(maxlen=200)

        self.current_target_vx = 0.0
        self.current_target_vy = 0.0
        self._target_block_remaining = 0

        self._seg_start_vx = 0.0
        self._seg_start_vy = 0.0
        self._seg_end_vx = 0.0
        self._seg_end_vy = 0.0

        self._manual_burst_until_ms: float = 0.0
        self._manual_burst_start_ms: float = 0.0
        self._manual_burst_duration_ms: float = 1.0
        self._manual_burst_vx: float = 0.0
        self._manual_burst_vy: float = 0.0

        self._replay: RecordingReplay | None = try_create_replay()
        self._mode: SimulatorMode = "live"
        self._playback_buffer_ms = float(
            np.clip(float(os.environ.get("PLAYBACK_LATENCY_BUFFER_MS", "120.0")), 40.0, 300.0)
        )
        self.replay_cursor_x = 0.5
        self.replay_cursor_y = 0.5
        self.current_pen_down = False

    @property
    def replay_active(self) -> bool:
        return self._replay is not None

    @property
    def mode(self) -> SimulatorMode:
        return self._mode

    @property
    def playback_active(self) -> bool:
        return self._mode == "playback" and self._replay is not None

    @property
    def replay_session_id(self) -> str | None:
        return self._replay.session_id if self._replay is not None else None

    @property
    def replay_recording_id(self) -> str | None:
        if self._replay is None:
            return None
        return self._replay.active_recording_id

    @property
    def replay_recording_file(self) -> str | None:
        rid = self.replay_recording_id
        return f"{rid}.json" if rid else None

    @property
    def replay_demo_id(self) -> str | None:
        """Legacy alias for ``replay_recording_id``."""
        return self.replay_recording_id

    @property
    def replay_paused(self) -> bool:
        return self._replay.paused if self._replay is not None else False

    @property
    def replay_elapsed_ms(self) -> float:
        return self._replay.elapsed_ms if self._replay is not None else 0.0

    @property
    def replay_duration_ms(self) -> float:
        return self._replay.duration_ms if self._replay is not None else 0.0

    @property
    def replay_progress(self) -> float:
        return self._replay.progress if self._replay is not None else 0.0

    @property
    def replay_speed(self) -> float:
        return self._replay.speed if self._replay is not None else 1.0

    def set_mode(self, mode: SimulatorMode) -> None:
        if mode == "playback" and self._replay is None:
            raise ValueError("Cannot enable playback mode without a loaded recording.")
        self._mode = mode

    def set_replay_recording_file(
        self,
        recording_file: str,
        *,
        timing: ReplayTiming = "original",
    ) -> None:
        """Load replay from an explicit ``recordings/*.json`` filename."""
        batch_ms = (self.fs // 50) * self.dt * 1000.0
        path = resolve_recording_file_path(recording_file)
        self._replay = RecordingReplay([path], batch_ms=batch_ms, timing=timing)
        self._mode = "playback"
        self.replay_cursor_x = 0.5
        self.replay_cursor_y = 0.5
        self.current_pen_down = False
        self.current_target_vx = 0.0
        self.current_target_vy = 0.0
        print(
            f"[simulator] replay file={recording_file} timing={timing} "
            f"session={self._replay.session_id}"
        )

    def set_replay_recording(
        self,
        recording_id: str,
        *,
        timing: ReplayTiming = "original",
    ) -> None:
        """Switch automatic-mode ground truth to a saved ``recordings/*.json`` file."""
        batch_ms = (self.fs // 50) * self.dt * 1000.0
        self._replay = create_replay_for_recording(
            recording_id,
            batch_ms=batch_ms,
            timing=timing,
        )
        self._mode = "playback"
        self.replay_cursor_x = 0.5
        self.replay_cursor_y = 0.5
        self.current_pen_down = False
        self.current_target_vx = 0.0
        self.current_target_vy = 0.0
        print(
            f"[simulator] replay recording id={recording_id} timing={timing} "
            f"session={self._replay.session_id}"
        )

    def set_replay_demo(self, demo_id: str) -> None:
        """Legacy alias — same as ``set_replay_recording``."""
        self.set_replay_recording(demo_id)

    def replay_play(self) -> None:
        if self._replay is not None:
            self._replay.play()

    def replay_pause(self) -> None:
        if self._replay is not None:
            self._replay.pause()

    def replay_restart(self) -> None:
        if self._replay is not None:
            self._replay.restart()
            self.replay_cursor_x = 0.5
            self.replay_cursor_y = 0.5
            self.current_pen_down = False
            self.current_target_vx = 0.0
            self.current_target_vy = 0.0

    def replay_seek(self, progress: float) -> None:
        if self._replay is not None:
            self._replay.seek_progress(progress)
            self.current_target_vx = 0.0
            self.current_target_vy = 0.0

    def replay_set_speed(self, speed: float) -> None:
        if self._replay is not None:
            self._replay.set_speed(speed)

    def trigger_manual_burst(self, vx: float, vy: float, duration_ms: float) -> None:
        """
        Short additive spike burst shaped by continuous velocity ``(vx, vy)`` in [-1, 1].

        ``vx = vy = 0`` cancels an active burst.
        """
        if abs(vx) < 1e-6 and abs(vy) < 1e-6:
            self._manual_burst_until_ms = 0.0
            return
        now_ms = time.time() * 1000.0
        duration_ms = float(max(50.0, min(duration_ms, 1200.0)))
        self._manual_burst_until_ms = now_ms + duration_ms
        self._manual_burst_start_ms = now_ms
        self._manual_burst_duration_ms = duration_ms
        self._manual_burst_vx = float(np.clip(vx, -1.0, 1.0))
        self._manual_burst_vy = float(np.clip(vy, -1.0, 1.0))

    def _manual_burst_envelope(self) -> float:
        """Smooth decay 1 → 0 over the burst window."""
        now_ms = time.time() * 1000.0
        if now_ms >= self._manual_burst_until_ms:
            return 0.0
        elapsed = now_ms - self._manual_burst_start_ms
        dur = max(self._manual_burst_duration_ms, 1e-6)
        t = min(1.0, elapsed / dur)
        return float(max(0.0, (1.0 - t) ** 1.28))

    def _manual_burst_extra_probability(self) -> np.ndarray:
        """Extra per-sample spike probability aligned with manual velocity (ring coding)."""
        env = self._manual_burst_envelope()
        if env <= 0.0:
            return np.zeros((self.num_channels,), dtype=np.float32)
        m = velocity_spike_multipliers(
            self._manual_burst_vx, self._manual_burst_vy, True, self.num_channels
        )
        extra = np.clip(env * 0.052 * np.maximum(m - 1.0, 0.0), 0.0, 0.06)
        return extra.astype(np.float32)

    def _pick_new_velocity_endpoint(self) -> None:
        """Sample a new segment endpoint ``(_seg_end_vx, _seg_end_vy)``."""
        if self.rng.random() < 0.2:
            self._seg_end_vx = float(self.rng.normal(0.0, 0.1))
            self._seg_end_vy = float(self.rng.normal(0.0, 0.1))
        else:
            ang = float(self.rng.uniform(-np.pi, np.pi))
            mag = float(self.rng.uniform(0.2, 1.0))
            self._seg_end_vx = float(np.clip(mag * np.cos(ang), -1.0, 1.0))
            self._seg_end_vy = float(np.clip(mag * np.sin(ang), -1.0, 1.0))

    def _advance_ground_truth(self, batch_ms: float) -> None:
        """Update ``current_target_*``, replay cursor, and pen from recording or random walk."""
        if self.playback_active:
            frame = self._replay.advance(batch_ms)
            self.current_target_vx = frame.vx
            self.current_target_vy = frame.vy
            self.replay_cursor_x = frame.x
            self.replay_cursor_y = frame.y
            self.current_pen_down = frame.clicked
            return

        if self._target_block_remaining <= 0:
            self._seg_start_vx = float(self._seg_end_vx)
            self._seg_start_vy = float(self._seg_end_vy)
            self._pick_new_velocity_endpoint()
            self._target_block_remaining = _VELOCITY_HOLD_BATCHES

        self._target_block_remaining -= 1
        n_hold = float(_VELOCITY_HOLD_BATCHES)
        frac = (n_hold - float(self._target_block_remaining)) / n_hold
        frac = float(np.clip(frac, 0.0, 1.0))
        vx = (1.0 - frac) * self._seg_start_vx + frac * self._seg_end_vx
        vy = (1.0 - frac) * self._seg_start_vy + frac * self._seg_end_vy
        self.current_target_vx = float(np.clip(vx, -1.0, 1.0))
        self.current_target_vy = float(np.clip(vy, -1.0, 1.0))
        self.current_pen_down = True

    async def stream(self) -> Dict[str, Any]:
        """Async generator that yields realistic 20 ms batches forever."""
        base_batch_size = self.fs // 50  # 20 ms baseline when live
        base_batch_ms = base_batch_size * self.dt * 1000.0
        t = 0.0
        redis_client = get_redis_client()
        playback_emit_deadline_ms: float | None = None

        if self._replay is not None:
            print(
                f"[simulator] replay active session={self._replay.session_id} "
                f"(recordings-driven ground truth)"
            )

        while True:
            step_ms = base_batch_ms
            if self.playback_active and self._replay is not None:
                step_ms = max(8.0, self._replay.next_step_ms(base_batch_ms))
            batch_size = max(1, int(round((step_ms / 1000.0) * self.fs)))

            noise = self.rng.normal(0, 1.0, size=(batch_size, self.num_channels))
            modulation = 0.3 * np.sin(2 * np.pi * self.freqs * t)  # vectorized
            lfp = (noise + modulation).tolist()

            base_prob = self.base_spike_rate * self.dt

            self._advance_ground_truth(step_ms)

            self._stream_step += 1
            self._velocity_ring.append((self.current_target_vx, self.current_target_vy))

            multipliers = velocity_spike_multipliers(
                self.current_target_vx,
                self.current_target_vy,
                self.current_pen_down,
                self.num_channels,
            )
            speed = float(np.hypot(self.current_target_vx, self.current_target_vy))
            multipliers = multipliers * float(1.0 + 0.28 * min(speed, 1.0))

            burst_extra = self._manual_burst_extra_probability()
            prob = np.clip(base_prob * multipliers + burst_extra, 0.0, 0.95)
            spikes = (self.rng.random((batch_size, self.num_channels)) < prob).astype(int).tolist()

            if self._stream_step % 50 == 0 and self._velocity_ring:
                mvx = float(np.mean([p[0] for p in self._velocity_ring]))
                mvy = float(np.mean([p[1] for p in self._velocity_ring]))
                print(f"[simulator] rolling mean target v=({mvx:+.2f},{mvy:+.2f})")

            packet = SignalPacket(
                timestamp_ms=time.time() * 1000,
                fs=self.fs,
                channels=self.num_channels,
                lfp=lfp,
                spikes=spikes,
            )

            if self.playback_active:
                source_ts_ms = packet.timestamp_ms
                now_ms = time.time() * 1000.0
                if playback_emit_deadline_ms is None:
                    playback_emit_deadline_ms = now_ms + self._playback_buffer_ms
                else:
                    playback_emit_deadline_ms += step_ms
                    if playback_emit_deadline_ms < now_ms:
                        playback_emit_deadline_ms = now_ms
                sleep_ms = playback_emit_deadline_ms - now_ms
                if sleep_ms > 0.5:
                    await asyncio.sleep(sleep_ms / 1000.0)
                # Keep timestamp as source-generation time so clients can measure one-way latency.
                packet.timestamp_ms = source_ts_ms
            else:
                playback_emit_deadline_ms = None

            dumped = packet.model_dump()
            if redis_client is not None:
                await redis_client.publish_signal_packet(dumped)
            yield dumped

            t += step_ms / 1000.0
            if not self.playback_active:
                await asyncio.sleep(step_ms / 1000.0)


generator = NeuralSignalGenerator(num_channels=32, fs=1000)
