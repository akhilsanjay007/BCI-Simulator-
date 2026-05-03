import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.decoder import BciDecoder, Intent, make_bootstrap_training_set
from app.simulator import generator

app = FastAPI(title="Neuralink BCI Signal Simulator")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global intent state 
current_intent: Intent = "right"

# Bootstrap-train decoder so /ws/decoder is runnable immediately.
decoder = BciDecoder(
    fs=generator.fs,
    channels=generator.num_channels,
    window_ms=200,
    exploration_prob=0.0,
)
try:
    X_train, y_train = make_bootstrap_training_set(
        fs=generator.fs, channels=generator.num_channels, window_ms=200, n_per_intent=300, seed=42
    )
    decoder.train(X_train, y_train)
except Exception as e:
    # If training fails for any reason, keep server runnable with heuristic fallback.
    print(f"⚠️ Decoder bootstrap training failed; using heuristic fallback. Error: {e}")


class SetIntentRequest(BaseModel):
    intent: Intent


class ManualBurstRequest(BaseModel):
    """Dashboard Manual mode: triggers a short additive spike burst on simulator channels."""

    intent: Intent
    duration_ms: float = Field(450.0, ge=50.0, le=1200.0)


@app.post("/manual-neural-burst")
async def manual_neural_burst(body: ManualBurstRequest) -> dict[str, str]:
    generator.trigger_manual_burst(body.intent, body.duration_ms)
    return {"status": "ok", "intent": body.intent}


@app.post("/set-intent")
async def set_intent(body: SetIntentRequest) -> dict[str, str]:
    global current_intent
    current_intent = body.intent
    return {"intent": current_intent}


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


@app.websocket("/ws/decoder")
async def decoder_stream(websocket: WebSocket):
    """
    WebSocket endpoint that streams live decoder outputs.

    Re-uses the simulator stream, runs decoder prediction per packet, and emits DecoderPacket JSON.
    """
    await websocket.accept()
    print("✅ Client connected — decoder stream live")
    try:
        async for packet in generator.stream():
            # Cursor position is integrated inside BciDecoder (velocity + damping + EMA).
            decoded = decoder.predict(packet["spikes"], true_intent=generator.current_stream_intent)
            out = decoded
            print(
                f"pred={out.predicted_intent} conf={out.confidence:.2f} "
                f"lat={out.latency_ms:.1f}ms roll20={out.accuracy:.2f} sess={out.session_accuracy:.2f} "
                f"intent={generator.current_stream_intent} "
                f"cursor=({out.cursor_x:.2f},{out.cursor_y:.2f})"
            )
            await websocket.send_json(out.model_dump())
    except WebSocketDisconnect:
        print("Decoder client disconnected")
    except Exception as e:
        print(f"Decoder error: {e}")
        await websocket.close()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
