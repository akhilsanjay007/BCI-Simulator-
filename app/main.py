import os
import re

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.decoder import BciDecoder, DecoderMode, generate_training_data
from app.redis_client import get_redis_client
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

# Bootstrap-train decoder so /ws/decoder is runnable immediately.
decoder = BciDecoder(
    fs=generator.fs,
    channels=generator.num_channels,
    window_ms=200,
    exploration_prob=0.0,
    output_mode="cursor",
)
try:
    X_train, y_train = generate_training_data(
        fs=generator.fs,
        channels=generator.num_channels,
        window_ms=200,
        n_samples=1800,
        seed=42,
    )
    decoder.train(X_train, y_train)
except Exception as e:
    # If training fails for any reason, keep server runnable with heuristic fallback.
    print(f"⚠️ Decoder bootstrap training failed; using heuristic fallback. Error: {e}")


class ManualBurstRequest(BaseModel):
    """Dashboard Manual mode: short additive spike burst shaped by ``(vx, vy)``."""

    vx: float = Field(..., ge=-1.0, le=1.0, description="Horizontal velocity hint [-1, 1].")
    vy: float = Field(..., ge=-1.0, le=1.0, description="Vertical velocity hint [-1, 1] (+y down).")
    duration_ms: float = Field(450.0, ge=50.0, le=1200.0)


class SetDecoderModeRequest(BaseModel):
    """Switch decoder output semantics (cursor vs handwriting pen lift)."""

    mode: DecoderMode


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "service": "neuralink-bci-sim-backend",
        "env": ENV,
        "decoder_trained": decoder.is_trained,
        "decoder_mode": decoder.output_mode,
        "num_channels": generator.num_channels,
        "fs": generator.fs,
    }


@app.get("/api/decoder/info")
async def decoder_info() -> dict[str, object]:
    """Decoder configuration and model type (for dashboards / ops)."""
    return {
        "decoder_mode": decoder.output_mode,
        "model_type": "RandomForestRegressor",
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


@app.post("/decoder/mode")
async def set_decoder_mode(body: SetDecoderModeRequest) -> dict[str, str]:
    """Runtime switch for handwriting vs cursor semantics (pen_down gating)."""
    decoder.set_output_mode(body.mode)
    return {"status": "ok", "mode": body.mode}


@app.post("/decoder/reset")
async def reset_decoder() -> dict[str, str]:
    decoder.reset_state()
    return {"status": "ok"}


@app.get("/simulator/config")
async def simulator_config() -> dict[str, int]:
    """Implements the same channel count as the live generator / decoder (for dashboard bootstrap)."""
    return {"num_channels": generator.num_channels, "fs": generator.fs}


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
    _log_i = 0
    try:
        async for packet in generator.stream():
            decoded = decoder.predict(
                packet["spikes"],
                true_vx=generator.current_target_vx,
                true_vy=generator.current_target_vy,
                true_pen_down=generator.current_stream_pen_down,
            )
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


@app.on_event("shutdown")
async def _shutdown() -> None:
    if redis_client is not None:
        await redis_client.close()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
