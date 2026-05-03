"""Synthetic Neuralink-style signal generator (shared by WebSocket streams)."""

from __future__ import annotations

import asyncio
import time
from collections import Counter, deque
from typing import Any, Deque, Dict

import numpy as np
from pydantic import BaseModel, Field

from app.decoder import Intent

_STREAM_INTENTS: tuple[Intent, ...] = ("left", "right", "up", "down", "rest")


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
    """Realistic Neuralink-style synthetic generator (learn-by-building signal processing)."""

    def __init__(self, num_channels: int = 32, fs: int = 1000, base_spike_rate_hz: float = 15.0):
        self.num_channels = num_channels
        self.fs = fs
        self.dt = 1.0 / fs
        self.base_spike_rate = base_spike_rate_hz
        self.rng = np.random.default_rng(seed=42)  # reproducible for demos
        self.freqs = self.rng.uniform(1, 30, num_channels)  # Hz
        self._stream_step = 0
        self._intent_ring: Deque[str] = deque(maxlen=200)
        self.current_stream_intent: Intent = "rest"

    async def stream(self) -> Dict[str, Any]:
        """Async generator that yields realistic 20 ms batches forever."""
        batch_size = self.fs // 50  # 20 ms batches → smooth real-time feel
        t = 0.0

        while True:
            noise = self.rng.normal(0, 1.0, size=(batch_size, self.num_channels))
            modulation = 0.3 * np.sin(2 * np.pi * self.freqs * t)  # vectorized
            lfp = (noise + modulation).tolist()

            base_prob = self.base_spike_rate * self.dt

            intent = _STREAM_INTENTS[self._stream_step % len(_STREAM_INTENTS)]
            self._stream_step += 1
            self.current_stream_intent = intent
            self._intent_ring.append(intent)

            multipliers = np.ones((self.num_channels,), dtype=np.float32)
            if intent == "right":
                multipliers[0:8] *= 3.0
            elif intent == "left":
                multipliers[8:16] *= 3.0
            elif intent == "up":
                multipliers[16:25] *= 3.0
            elif intent == "down":
                multipliers[25:32] *= 3.0
            # rest: leave multipliers at 1.0

            prob = np.clip(base_prob * multipliers, 0.0, 0.95)
            spikes = (self.rng.random((batch_size, self.num_channels)) < prob).astype(int).tolist()

            if self._stream_step % 50 == 0 and self._intent_ring:
                hist = Counter(self._intent_ring)
                keys = sorted(hist.keys())
                counts = ", ".join(f"{k}={hist[k]}" for k in keys)
                print(f"[simulator] intent distribution (last {len(self._intent_ring)}): {counts}")

            packet = SignalPacket(
                timestamp_ms=time.time() * 1000,
                fs=self.fs,
                channels=self.num_channels,
                lfp=lfp,
                spikes=spikes,
            )

            yield packet.model_dump()

            t += batch_size * self.dt
            await asyncio.sleep(batch_size * self.dt)


generator = NeuralSignalGenerator(num_channels=32, fs=1000)
