from __future__ import annotations

from fastapi.testclient import TestClient

from app.core.decoder import DecoderPacket
from app.core.main import app, generator, manual_decoder


def test_manual_decoder_predict_uses_real_decoder(monkeypatch) -> None:
    synth_calls: list[tuple[float, float, bool, int]] = []
    predict_calls: list[tuple[float, float, int]] = []

    def fake_synthesize_spikes_for_velocity(
        *,
        vx: float,
        vy: float,
        pen_down: bool,
        batch_samples: int,
    ) -> list[list[int]]:
        synth_calls.append((float(vx), float(vy), bool(pen_down), int(batch_samples)))
        return [[0] * generator.num_channels for _ in range(batch_samples)]

    def fake_predict(spikes_batch, *, true_vx: float, true_vy: float) -> DecoderPacket:
        predict_calls.append((float(true_vx), float(true_vy), len(spikes_batch)))
        return DecoderPacket(
            timestamp_ms=1_800_000_000_000.0,
            vx=0.12,
            vy=-0.09,
            pen_down=True,
            confidence=0.77,
            decode_latency_ms=4.3,
            end_to_end_latency_ms=4.3,
            redis_buffer_seconds=12.5,
            accuracy=0.64,
            session_accuracy=0.66,
            cursor_x=0.42,
            cursor_y=0.58,
            num_channels=generator.num_channels,
        )

    monkeypatch.setattr(generator, "synthesize_spikes_for_velocity", fake_synthesize_spikes_for_velocity)
    monkeypatch.setattr(manual_decoder, "predict", fake_predict)

    with TestClient(app) as client:
        response = client.post(
            "/manual-decoder-predict",
            json={"vx": 0.35, "vy": -0.2, "pen_down": True, "batch_samples": 20},
        )

    assert response.status_code == 200
    body = response.json()
    assert synth_calls == [(0.35, -0.2, True, 20)]
    assert predict_calls == [(0.35, -0.2, 20)]
    assert body["confidence"] == 0.77
    assert body["decode_latency_ms"] == 4.3
    assert body["redis_buffer_seconds"] == 12.5
    assert body["accuracy"] == 0.64
    assert body["session_accuracy"] == 0.66
