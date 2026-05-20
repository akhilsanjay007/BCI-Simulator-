import asyncio
import os
import re
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.decoder import (
    BciDecoder,
    RegressorKind,
    default_decoder_artifact_path,
    generate_training_data,
    load_decoder_artifact_into,
    velocity_decoder_missing_help,
)
from app.redis_client import get_redis_client
from app.recording_replay import (
    ReplayTiming,
    list_recordings,
    validate_recording_id,
)
from app.simulator import generator

ENV = os.getenv("ENV", "development").lower()
IS_PRODUCTION = ENV == "production"

LOCAL_FRONTEND_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]

# Railway assigns public domains per service. This allows generated Railway
# frontend domains without opening CORS to every origin in production.
RAILWAY_FRONTEND_ORIGIN_RE = re.compile(r"^https://[a-z0-9][a-z0-9-]*\.up\.railway\.app$")


def _normalize_origin(origin: str) -> str:
    return origin.strip().rstrip("/")


def _configured_frontend_origins() -> list[str]:
    raw_values = [
        os.getenv("FRONTEND_URL", ""),
        os.getenv("FRONTEND_ORIGIN", ""),
        os.getenv("CORS_ALLOWED_ORIGINS", ""),
    ]
    origins: list[str] = []
    for raw in raw_values:
        for value in raw.split(","):
            origin = _normalize_origin(value)
            if origin:
                origins.append(origin)
    return origins


ALLOWED_FRONTEND_ORIGINS = [
    *([] if IS_PRODUCTION else LOCAL_FRONTEND_ORIGINS),
    *_configured_frontend_origins(),
]


def is_allowed_origin(origin: str | None) -> bool:
    if not origin:
        return not IS_PRODUCTION

    normalized = _normalize_origin(origin)
    return normalized in ALLOWED_FRONTEND_ORIGINS or bool(RAILWAY_FRONTEND_ORIGIN_RE.fullmatch(normalized))


async def accept_allowed_websocket(websocket: WebSocket) -> bool:
    if is_allowed_origin(websocket.headers.get("origin")):
        await websocket.accept()
        return True

    await websocket.close(code=1008)
    return False


app = FastAPI(title="Neuralink BCI Signal Simulator")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_FRONTEND_ORIGINS,
    allow_origin_regex=RAILWAY_FRONTEND_ORIGIN_RE.pattern,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "Origin", "User-Agent", "Cache-Control", "X-Requested-With"],
)

# Optional Redis Streams client (enabled when REDIS_URL is set).
redis_client = get_redis_client()


class DecoderWebSocketHub:
    """Tracks live ``/ws/decoder`` clients for broadcast events (e.g. reset)."""

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def register(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.add(websocket)
        print(f"[ws/decoder] client registered ({len(self._clients)} total)")

    async def unregister(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(websocket)
        print(f"[ws/decoder] client unregistered ({len(self._clients)} total)")

    async def broadcast_json(self, payload: dict[str, Any]) -> int:
        async with self._lock:
            clients = list(self._clients)
        if not clients:
            return 0
        dead: list[WebSocket] = []
        sent = 0
        for ws in clients:
            try:
                await ws.send_json(payload)
                sent += 1
            except Exception as e:
                print(f"[ws/decoder] broadcast failed for one client: {e}")
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)
        return sent


decoder_ws_hub = DecoderWebSocketHub()

_reg_raw = os.getenv("DECODER_REGRESSOR", "ensemble").strip().lower()
_decoder_reg: RegressorKind
if _reg_raw == "rf":
    _decoder_reg = "rf"
elif _reg_raw == "hgb":
    _decoder_reg = "hgb"
else:
    _decoder_reg = "ensemble"

# Bootstrap-train decoder so /ws/decoder is runnable immediately.
decoder = BciDecoder(
    fs=generator.fs,
    channels=generator.num_channels,
    window_ms=200,
    exploration_prob=0.0,
    regressor=_decoder_reg,
)
_decoder_train_n = int(os.getenv("DECODER_TRAIN_SAMPLES", "25000"))

# Must match the Railway volume mount path (e.g. volume `decoder-model` → `/app/models`).
RAILWAY_VOLUME_MODEL_PATH = Path("/app/models/velocity_decoder.pkl")


def _decoder_artifact_path_from_env() -> tuple[Path, bool]:
    """Return (resolved path, True if MODEL_PATH or DECODER_MODEL_PATH was set). MODEL_PATH wins."""
    for key in ("MODEL_PATH", "DECODER_MODEL_PATH"):
        raw = os.getenv(key, "").strip()
        if raw:
            p = Path(raw)
            return (p.resolve() if p.is_absolute() else (Path.cwd() / p).resolve(), True)
    if RAILWAY_VOLUME_MODEL_PATH.is_file():
        return RAILWAY_VOLUME_MODEL_PATH.resolve(), False
    return default_decoder_artifact_path().resolve(), False


def _load_decoder_at_startup() -> None:
    artifact_path, artifact_path_explicit = _decoder_artifact_path_from_env()
    try:
        if artifact_path.is_file():
            load_decoder_artifact_into(decoder, artifact_path)
            if artifact_path == RAILWAY_VOLUME_MODEL_PATH.resolve():
                print(f"✅ Successfully loaded model from Railway Volume: {artifact_path}")
            else:
                print(f"✅ Successfully loaded model: {artifact_path}")
            return
        if IS_PRODUCTION or artifact_path_explicit:
            raise FileNotFoundError(velocity_decoder_missing_help(artifact_path))
        try:
            X_train, y_train = generate_training_data(
                fs=generator.fs,
                channels=generator.num_channels,
                window_ms=200,
                n_samples=max(1800, _decoder_train_n),
                seed=42,
            )
            decoder.train(X_train, y_train)
            print(f"Bootstrap-trained decoder on {len(X_train):,} synthetic windows")
        except Exception as e:
            print(f"⚠️ Decoder bootstrap training failed; using heuristic fallback. Error: {e}")
    except FileNotFoundError as e:
        print(f"❌ Failed to load model: {e}")
        raise
    except Exception as e:
        print(f"❌ Failed to load model: {e}")
        if IS_PRODUCTION:
            raise RuntimeError(f"Velocity decoder failed to load or train: {e}") from e
        print("⚠️ Decoder load/bootstrap failed; using heuristic fallback.")


_load_decoder_at_startup()


class ManualBurstRequest(BaseModel):
    """Dashboard Manual mode: short additive spike burst shaped by ``(vx, vy)``."""

    vx: float = Field(..., ge=-1.0, le=1.0, description="Horizontal velocity hint [-1, 1].")
    vy: float = Field(..., ge=-1.0, le=1.0, description="Vertical velocity hint [-1, 1] (+y down).")
    duration_ms: float = Field(450.0, ge=50.0, le=1200.0)


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "service": "neuralink-bci-sim-backend",
        "env": ENV,
        "decoder_trained": decoder.is_trained,
        "num_channels": generator.num_channels,
        "fs": generator.fs,
    }


@app.get("/api/decoder/info")
async def decoder_info() -> dict[str, object]:
    """Decoder configuration and model type (for dashboards / ops)."""
    _mt = {
        "rf": "RandomForestRegressor",
        "hgb": "HistGradientBoostingRegressor(dual vx/vy)",
        "ensemble": "Ensemble(RandomForestRegressor + HistGradientBoostingRegressor)",
    }[decoder.regressor_kind]
    return {
        "regressor": decoder.regressor_kind,
        "model_type": _mt,
        "target_outputs": ["vx", "vy"],
        "velocity_range": {"vx": [-1.0, 1.0], "vy": [-1.0, 1.0]},
        "is_trained": decoder.is_trained,
        "n_features": decoder.n_features,
        "fs_hz": generator.fs,
        "num_channels": generator.num_channels,
        "window_ms": decoder.window_ms,
    }


@app.get("/health/redis")
async def health_redis() -> dict[str, object]:
    if redis_client is None:
        return {"status": "disabled"}
    ok = await redis_client.ping()
    return {"status": "ok" if ok else "error", "stream": redis_client.stream_signals}


@app.post("/manual-neural-burst")
async def manual_neural_burst(body: ManualBurstRequest) -> dict[str, str]:
    generator.trigger_manual_burst(body.vx, body.vy, body.duration_ms)
    return {"status": "ok", "vx": str(body.vx), "vy": str(body.vy)}


@app.post("/decoder/reset")
async def reset_decoder() -> dict[str, object]:
    """
    Reset decoder state, clear Redis signal buffer (if configured), and notify dashboards.
    """
    print("[decoder/reset] POST received — clearing decoder + notifying WebSocket clients")
    decoder.reset()
    redis_cleared = False
    if redis_client is not None:
        redis_cleared = await redis_client.clear_signal_stream()
    reset_event = decoder.build_reset_event(num_channels=generator.num_channels)
    payload = reset_event.model_dump()
    clients_notified = await decoder_ws_hub.broadcast_json(payload)
    print(
        f"[decoder/reset] done redis_cleared={redis_cleared} "
        f"ws_clients_notified={clients_notified} cursor=({reset_event.cursor_x:.2f},{reset_event.cursor_y:.2f})"
    )
    return {
        "status": "ok",
        "redis_cleared": redis_cleared,
        "ws_clients_notified": clients_notified,
    }


class SelectRecordingRequest(BaseModel):
    recording_id: str = Field(
        ...,
        min_length=1,
        max_length=128,
        description="Recording stem, e.g. demo_1 or session_20260520_012021",
    )
    timing: ReplayTiming = Field(
        default="original",
        description="original = sample timestamps; smooth_125hz = uniform 8 ms resample",
    )


class RecordingResponse(BaseModel):
    recording_id: str
    label: str
    typed_text: str
    duration_ms: int
    sample_count: int


@app.get("/api/recordings")
async def list_recordings_endpoint() -> dict[str, object]:
    """Selectable ``recordings/*.json`` files for automatic-mode replay."""
    items = list_recordings()
    selected = generator.replay_recording_id
    return {
        "recordings": [
            RecordingResponse(
                recording_id=r.recording_id,
                label=r.label,
                typed_text=r.typed_text,
                duration_ms=r.duration_ms,
                sample_count=r.sample_count,
            ).model_dump()
            for r in items
        ],
        "selected_recording_id": selected,
        "replay_active": generator.replay_active,
        # Legacy fields for older dashboards
        "demos": [
            RecordingResponse(
                recording_id=r.recording_id,
                label=r.label,
                typed_text=r.typed_text,
                duration_ms=r.duration_ms,
                sample_count=r.sample_count,
            ).model_dump()
            for r in items
            if r.recording_id.startswith("demo_")
        ],
        "selected_demo_id": selected,
    }


@app.post("/api/recordings/select")
async def select_recording(body: SelectRecordingRequest) -> dict[str, object]:
    """Switch replay recording, reset decoder, and notify connected dashboards."""
    try:
        recording_id = validate_recording_id(body.recording_id)
    except ValueError as e:
        return {"status": "error", "message": str(e)}

    try:
        generator.set_replay_recording(recording_id, timing=body.timing)
    except FileNotFoundError as e:
        return {"status": "error", "message": str(e)}

    decoder.reset()
    redis_cleared = False
    if redis_client is not None:
        redis_cleared = await redis_client.clear_signal_stream()
    reset_event = decoder.build_reset_event(num_channels=generator.num_channels)
    clients_notified = await decoder_ws_hub.broadcast_json(reset_event.model_dump())
    print(
        f"[recordings/select] recording={recording_id} timing={body.timing} "
        f"redis_cleared={redis_cleared} ws_clients_notified={clients_notified}"
    )
    return {
        "status": "ok",
        "selected_recording_id": recording_id,
        "selected_demo_id": recording_id,
        "replay_session_id": generator.replay_session_id,
        "redis_cleared": redis_cleared,
        "ws_clients_notified": clients_notified,
    }


@app.get("/simulator/config")
async def simulator_config() -> dict[str, int | bool | str | None]:
    """Implements the same channel count as the live generator / decoder (for dashboard bootstrap)."""
    return {
        "num_channels": generator.num_channels,
        "fs": generator.fs,
        "replay_active": generator.replay_active,
        "replay_session_id": generator.replay_session_id,
        "selected_recording_id": generator.replay_recording_id,
        "selected_demo_id": generator.replay_recording_id,
    }


@app.websocket("/ws/bci-stream")
async def bci_stream(websocket: WebSocket):
    """Production WebSocket endpoint — low latency, graceful disconnects."""
    if not await accept_allowed_websocket(websocket):
        return
    print(f"✅ Client connected — streaming {generator.num_channels} channels @ {generator.fs} Hz")
    try:
        async for packet in generator.stream():
            await websocket.send_json(packet)
    except WebSocketDisconnect:
        print("Client disconnected")
    except Exception as e:
        print(f"Error: {e}")
        await websocket.close()


@app.websocket("/ws/decoder")
async def decoder_stream(websocket: WebSocket):
    """
    WebSocket endpoint that streams live decoder outputs.

    Re-uses the simulator stream, runs decoder prediction per packet, and emits DecoderPacket JSON.
    """
    if not await accept_allowed_websocket(websocket):
        return
    print("✅ Client connected — decoder stream live")
    await decoder_ws_hub.register(websocket)
    _log_i = 0
    try:
        async for packet in generator.stream():
            decoded = decoder.predict(
                packet["spikes"],
                true_vx=generator.current_target_vx,
                true_vy=generator.current_target_vy,
            )
            if generator.replay_active:
                out = decoded.model_copy(
                    update={
                        "vx": generator.current_target_vx,
                        "vy": generator.current_target_vy,
                        "pen_down": generator.current_pen_down,
                        "cursor_x": generator.replay_cursor_x,
                        "cursor_y": generator.replay_cursor_y,
                    }
                )
            else:
                out = decoded
            _log_i += 1
            if _log_i % 50 == 0:
                print(
                    f"[ws/decoder] v=({out.vx:+.2f},{out.vy:+.2f}) pen={out.pen_down} conf={out.confidence:.2f} "
                    f"lat={out.latency_ms:.1f}ms roll20={out.accuracy:.2f} sess={out.session_accuracy:.2f} "
                    f"true=({generator.current_target_vx:+.2f},{generator.current_target_vy:+.2f}) "
                    f"cursor=({out.cursor_x:.2f},{out.cursor_y:.2f})"
                )
            await websocket.send_json(out.model_dump())
    except WebSocketDisconnect:
        print("Decoder client disconnected")
    except Exception as e:
        print(f"Decoder error: {e}")
        await websocket.close()
    finally:
        await decoder_ws_hub.unregister(websocket)


@app.on_event("shutdown")
async def _shutdown() -> None:
    if redis_client is not None:
        await redis_client.close()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
