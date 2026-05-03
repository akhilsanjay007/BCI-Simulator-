import asyncio
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from app.decoder import BciDecoder, Intent, make_bootstrap_training_set
from app.simulator import generator

app = FastAPI(title="Neuralink BCI Signal Simulator")

# 2D cursor: normalized units per second at full "speed" for one axis
CURSOR_SPEED_PER_S = 0.85


def _step_cursor(
    x: float,
    y: float,
    intent: str,
    *,
    batch_samples: int,
    fs: int,
) -> tuple[float, float]:
    dt_s = batch_samples / float(fs)
    step = CURSOR_SPEED_PER_S * dt_s
    if intent == "right":
        x += step
    elif intent == "left":
        x -= step
    elif intent == "up":
        y -= step
    elif intent == "down":
        y += step
    return float(np.clip(x, 0.0, 1.0)), float(np.clip(y, 0.0, 1.0))

# Global intent state 
current_intent: Intent = "right"

# Bootstrap-train decoder so /ws/decoder is runnable immediately.
decoder = BciDecoder(fs=generator.fs, channels=generator.num_channels, window_ms=200)
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


@app.post("/set-intent")
async def set_intent(body: SetIntentRequest) -> dict[str, str]:
    global current_intent
    current_intent = body.intent
    return {"intent": current_intent}

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
    cursor_x, cursor_y = 0.5, 0.5
    try:
        async for packet in generator.stream():
            # Keep /ws/bci-stream unchanged; decoder uses spikes only.
            decoded = decoder.predict(packet["spikes"], true_intent=generator.current_stream_intent)
            spikes = packet["spikes"]
            batch_samples = len(spikes) if spikes else 0
            cursor_x, cursor_y = _step_cursor(
                cursor_x,
                cursor_y,
                decoded.predicted_intent,
                batch_samples=batch_samples,
                fs=int(packet.get("fs", generator.fs)),
            )
            out = decoded.model_copy(update={"cursor_x": cursor_x, "cursor_y": cursor_y})
            print(
                f"pred={out.predicted_intent} conf={out.confidence:.2f} "
                f"lat={out.latency_ms:.1f}ms acc={out.accuracy:.2f} intent={generator.current_stream_intent} "
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
