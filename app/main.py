import asyncio
import time
import json
from typing import Dict, Any
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

app = FastAPI(title="Neuralink BCI Signal Simulator")

class SignalPacket(BaseModel):
    """Typed packet sent over WebSocket — exactly what a real decoder expects."""
    timestamp: float = Field(..., description="Unix timestamp (ms precision)")
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
        # Per-channel low-frequency modulation (real neurons aren't pure noise)
        self.freqs = self.rng.uniform(1, 30, num_channels)  # Hz

    async def stream(self) -> Dict[str, Any]:
        """Async generator that yields realistic 20 ms batches forever."""
        batch_size = self.fs // 50  # 20 ms batches → smooth real-time feel
        t = 0.0

        while True:
            # LFP: 1/f-like noise + sinusoidal modulation per channel
            noise = self.rng.normal(0, 1.0, size=(batch_size, self.num_channels))
            modulation = 0.3 * np.sin(2 * np.pi * self.freqs * t)  # vectorized
            lfp = (noise + modulation).tolist()

            # Spikes: inhomogeneous Poisson process (realistic firing)
            prob = self.base_spike_rate * self.dt
            spikes = (self.rng.random((batch_size, self.num_channels)) < prob).astype(int).tolist()

            packet = SignalPacket(
                timestamp=time.time(),
                fs=self.fs,
                channels=self.num_channels,
                lfp=lfp,
                spikes=spikes,
            )

            yield packet.model_dump()  # Pydantic → dict for JSON

            t += batch_size * self.dt
            await asyncio.sleep(batch_size * self.dt)  # real-time timing

# Global generator (singleton for MVP)
generator = NeuralSignalGenerator(num_channels=32, fs=1000)

@app.websocket("/ws/bci-stream")
async def bci_stream(websocket: WebSocket):
    """Production WebSocket endpoint — low latency, graceful disconnects."""
    await websocket.accept()
    print(f"✅ Client connected — streaming {generator.num_channels} channels @ {generator.fs} Hz")
    try:
        async for packet in generator.stream():
            await websocket.send_json(packet)
    except WebSocketDisconnect:
        print("Client disconnected")
    except Exception as e:
        print(f"Error: {e}")
        await websocket.close()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
