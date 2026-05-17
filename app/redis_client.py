from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from redis.asyncio import ConnectionPool, Redis
from redis.exceptions import RedisError

DEFAULT_STREAM_SIGNALS = "bci:signals"


@dataclass(frozen=True)
class RedisClientConfig:
    url: str
    stream_signals: str
    retention_seconds: float
    max_connections: int
    socket_connect_timeout_s: float
    socket_timeout_s: float


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return float(raw)


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return int(raw)


def load_redis_config() -> Optional[RedisClientConfig]:
    url = os.getenv("REDIS_URL", "").strip()
    if not url:
        return None

    stream_signals = os.getenv("REDIS_STREAM_SIGNALS", DEFAULT_STREAM_SIGNALS).strip() or DEFAULT_STREAM_SIGNALS
    retention_seconds = _env_float("REDIS_STREAM_RETENTION_SECONDS", 20.0)
    max_connections = _env_int("REDIS_MAX_CONNECTIONS", 50)

    socket_connect_timeout_s = _env_float("REDIS_SOCKET_CONNECT_TIMEOUT_SECONDS", 1.0)
    socket_timeout_s = _env_float("REDIS_SOCKET_TIMEOUT_SECONDS", 1.0)

    if retention_seconds <= 0:
        raise ValueError("REDIS_STREAM_RETENTION_SECONDS must be positive")
    if max_connections <= 0:
        raise ValueError("REDIS_MAX_CONNECTIONS must be positive")
    if socket_connect_timeout_s <= 0 or socket_timeout_s <= 0:
        raise ValueError("Redis socket timeouts must be positive")

    return RedisClientConfig(
        url=url,
        stream_signals=stream_signals,
        retention_seconds=retention_seconds,
        max_connections=max_connections,
        socket_connect_timeout_s=socket_connect_timeout_s,
        socket_timeout_s=socket_timeout_s,
    )


class BCIRedisClient:
    """
    Production-grade Redis Streams buffer for BCI signal packets.

    - Async client with connection pooling
    - Publishes to a configured stream (default: bci:signals)
    - Trims by *time* (keeps last N seconds) using XTRIM MINID (~) on ms-based IDs
    """

    def __init__(self, *, config: RedisClientConfig) -> None:
        self._cfg = config
        self._pool = ConnectionPool.from_url(
            self._cfg.url,
            max_connections=self._cfg.max_connections,
            socket_connect_timeout=self._cfg.socket_connect_timeout_s,
            socket_timeout=self._cfg.socket_timeout_s,
            decode_responses=False,
        )
        self._redis = Redis(connection_pool=self._pool)

        # Avoid log spam on transient Redis issues.
        self._last_error_log_ms: float = 0.0

    @property
    def stream_signals(self) -> str:
        return self._cfg.stream_signals

    async def close(self) -> None:
        await self._redis.aclose()
        await self._pool.disconnect(inuse_connections=True)

    async def ping(self) -> bool:
        try:
            r = await self._redis.ping()
            return bool(r)
        except RedisError:
            return False

    def _should_log_error(self, *, now_ms: float, min_interval_ms: float = 2000.0) -> bool:
        if now_ms - self._last_error_log_ms >= min_interval_ms:
            self._last_error_log_ms = now_ms
            return True
        return False

    async def clear_signal_stream(self) -> bool:
        """Delete the signals stream so buffered packets do not survive a decoder reset."""
        try:
            deleted = await self._redis.delete(self._cfg.stream_signals)
            print(f"[redis] clear_signal_stream: deleted {self._cfg.stream_signals} (removed={deleted})")
            return True
        except RedisError as e:
            now_ms = time.time() * 1000.0
            if self._should_log_error(now_ms=now_ms):
                print(f"[redis] clear_signal_stream failed: {e}")
            return False

    async def publish_signal_packet(self, packet: Mapping[str, Any]) -> None:
        """
        Publish one simulator packet to Redis Streams and keep only last N seconds.

        The stream entry ID is ms-based (`<timestamp_ms>-*`) so time trimming is monotonic.
        """
        now_ms = time.time() * 1000.0
        try:
            ts_ms_val = packet.get("timestamp_ms", now_ms)
            ts_ms = float(ts_ms_val) if ts_ms_val is not None else float(now_ms)
        except (TypeError, ValueError):
            ts_ms = float(now_ms)

        entry_id = f"{int(ts_ms)}-*"
        min_keep_ms = int(ts_ms - (self._cfg.retention_seconds * 1000.0))
        min_id = f"{min_keep_ms}-0"

        try:
            payload = json.dumps(packet, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            # Keep payload as bytes (decode_responses=False) to avoid round-trips on encoding.
            await self._redis.xadd(
                self._cfg.stream_signals,
                fields={b"payload": payload, b"timestamp_ms": str(int(ts_ms)).encode("ascii")},
                id=entry_id,
            )
            # Approximate trim (time-based) so memory remains bounded.
            # redis-py doesn't currently expose MINID on xtrim() in all versions; use raw command.
            await self._redis.execute_command("XTRIM", self._cfg.stream_signals, "MINID", "~", min_id)
        except RedisError as e:
            if self._should_log_error(now_ms=now_ms):
                print(f"[redis] publish failed: {e}")


_redis_singleton: Optional[BCIRedisClient] = None


def get_redis_client() -> Optional[BCIRedisClient]:
    """
    Lazy singleton. Returns None when REDIS_URL is not configured.

    Safe to call from import-time code (does not touch the event loop).
    """
    global _redis_singleton
    if _redis_singleton is not None:
        return _redis_singleton
    cfg = load_redis_config()
    if cfg is None:
        return None
    _redis_singleton = BCIRedisClient(config=cfg)
    return _redis_singleton

