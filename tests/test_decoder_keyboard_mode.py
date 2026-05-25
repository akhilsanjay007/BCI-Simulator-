"""Decoder contract after handwriting mode removal."""

from fastapi.testclient import TestClient

from app.decoder import BciDecoder, DecoderPacket
from app.main import app


def test_decoder_packet_has_no_mode_field() -> None:
    decoder = BciDecoder(fs=1000, channels=8, window_ms=200, exploration_prob=0.0)
    spikes = [[0] * 8 for _ in range(20)]
    pkt = decoder.predict(spikes, true_vx=0.5, true_vy=0.0)
    assert isinstance(pkt, DecoderPacket)
    body = pkt.model_dump()
    assert "mode" not in body
    assert "decode_latency_ms" in body
    assert "end_to_end_latency_ms" in body
    assert "redis_buffer_seconds" in body
    assert "latency_ms" not in body


def test_post_decoder_mode_removed() -> None:
    client = TestClient(app)
    r = client.post("/decoder/mode", json={"mode": "handwriting"})
    assert r.status_code == 404


def test_health_has_no_decoder_mode() -> None:
    client = TestClient(app)
    body = client.get("/health").json()
    assert "decoder_mode" not in body
