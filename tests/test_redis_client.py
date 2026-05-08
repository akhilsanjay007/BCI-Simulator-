from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

from app.redis_client import BCIRedisClient, RedisClientConfig


def test_publish_signal_packet_trims_by_time() -> None:
    cfg = RedisClientConfig(
        url="redis://localhost:6379/0",
        stream_signals="bci:signals",
        retention_seconds=20.0,
        max_connections=2,
        socket_connect_timeout_s=1.0,
        socket_timeout_s=1.0,
    )
    client = BCIRedisClient(config=cfg)
    client._redis = AsyncMock()  # type: ignore[assignment]

    packet = {"timestamp_ms": 123_456.0, "fs": 1000, "channels": 32, "lfp": [[0.0]], "spikes": [[0]]}
    asyncio.run(client.publish_signal_packet(packet))

    assert client._redis.xadd.await_count == 1  # type: ignore[attr-defined]
    args, kwargs = client._redis.xadd.await_args  # type: ignore[attr-defined]
    assert args[0] == "bci:signals"
    assert kwargs["id"].startswith("123456-")

    # Should issue XTRIM MINID with an approximate threshold.
    client._redis.execute_command.assert_awaited()  # type: ignore[attr-defined]
    trim_args, _ = client._redis.execute_command.await_args  # type: ignore[attr-defined]
    assert trim_args[:4] == ("XTRIM", "bci:signals", "MINID", "~")
