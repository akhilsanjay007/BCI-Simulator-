"""Replay decoder metrics should come from real decoder.predict outputs."""

from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from app.decoder import DecoderPacket
from app.main import app, decoder, generator


def test_ws_decoder_replay_uses_predict_metrics(monkeypatch) -> None:
    async def fake_stream():
        spikes = [[0] * generator.num_channels for _ in range(20)]
        ts = 1_800_000_000_000.0
        for i in range(10):
            yield {"timestamp_ms": ts + (i * 20.0), "spikes": spikes}
            await asyncio.sleep(0)

    predict_calls: list[tuple[float, float]] = []

    def fake_predict(spikes_batch, *, true_vx: float, true_vy: float) -> DecoderPacket:
        predict_calls.append((float(true_vx), float(true_vy)))
        assert len(spikes_batch) > 0
        return DecoderPacket(
            timestamp_ms=1_800_000_000_000.0,
            vx=0.11,
            vy=-0.07,
            pen_down=True,
            confidence=0.41,
            decode_latency_ms=7.2,
            end_to_end_latency_ms=7.2,
            accuracy=0.58,
            session_accuracy=0.61,
            cursor_x=0.3,
            cursor_y=0.4,
            num_channels=generator.num_channels,
        )

    monkeypatch.setattr(generator, "stream", fake_stream)
    monkeypatch.setattr(type(generator), "playback_active", property(lambda self: True))
    monkeypatch.setattr(decoder, "predict", fake_predict)
    generator.current_target_vx = 0.25
    generator.current_target_vy = -0.15
    generator.current_pen_down = True
    generator.replay_cursor_x = 0.73
    generator.replay_cursor_y = 0.21

    seen_packets: list[dict] = []
    with TestClient(app) as client:
        with client.websocket_connect("/ws/decoder", headers={"origin": "http://localhost:5173"}) as ws:
            for _ in range(10):
                try:
                    msg = ws.receive_json()
                except Exception:
                    break
                seen_packets.append(msg)
                if msg.get("confidence", 0.0) > 0:
                    break

    assert predict_calls, "Replay path should call decoder.predict for authentic metrics"
    assert seen_packets, "Replay websocket should emit packets"
    latest = seen_packets[-1]
    assert latest["vx"] == generator.current_target_vx
    assert latest["vy"] == generator.current_target_vy
    assert latest["cursor_x"] == generator.replay_cursor_x
    assert latest["cursor_y"] == generator.replay_cursor_y
    assert latest["confidence"] == 0.41
    assert latest["accuracy"] == 0.58
    assert latest["session_accuracy"] == 0.61
