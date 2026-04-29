# neuralink-bci-sim

Synthetic neural-style signals over a WebSocket: LFP-style traces and sparse spike events, typed with Pydantic and streamed from a small **FastAPI** service. Useful for prototyping decoders, dashboards, or BCI pipelines without hardware.

## Requirements

- Python 3.10 or newer (3.13 is fine)
- A virtual environment (recommended)

## Setup

```powershell
cd neuralink-bci-sim
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

On macOS or Linux, activate with `source venv/bin/activate`.

## Run the server

From the **repository root** (the folder that contains `app/`):

```powershell
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Open [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs) for the interactive OpenAPI UI.

## WebSocket stream

- **URL:** `ws://localhost:8000/ws/bci-stream`
- **Payload:** JSON objects with `timestamp_ms`, `fs`, `channels`, `lfp` (2D list of samples × channels), and `spikes` (binary events).

## Intent control

Set the global simulator intent (used to bias spike probabilities):

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/set-intent -ContentType "application/json" -Body '{\"intent\":\"up\"}'
```

Valid intents: `left`, `right`, `up`, `down`.

## Decoder stream

- **URL:** `ws://localhost:8000/ws/decoder`
- **Payload:** JSON objects with `timestamp_ms`, `predicted_intent`, `confidence`, `latency_ms`, `accuracy`.

## Sample client

With the server running, in another terminal from the same root:

```powershell
python tests/test_client.py
```

This connects with `websockets`, receives a handful of packets, and prints a short summary per packet.

## Decoder sample client

With the server running, in another terminal from the same root:

```powershell
python tests/test_decoder_client.py
```

## Project layout

```
neuralink-bci-sim/
├── app/
│   ├── __init__.py
│   └── main.py          # FastAPI app + generator + /ws/bci-stream
├── tests/
│   ├── __init__.py
│   └── test_client.py   # optional manual WebSocket smoke test
├── requirements.txt
└── README.md
```

The `venv/` directory is created locally and is listed in `.gitignore`; it should not be committed.
