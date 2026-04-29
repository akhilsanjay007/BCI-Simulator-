# neuralink-bci-sim

Synthetic neural-style signals over a WebSocket: LFP-style traces and sparse spike events, typed with Pydantic and streamed from a small **FastAPI** service. Useful for prototyping decoders, dashboards, or BCI pipelines without hardware.

## Requirements

- Python 3.10 or newer (3.13 is fine)
- A virtual environment (recommended)
- Dependencies in `requirements.txt`

## Setup

```powershell
cd neuralink-bci-sim
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

On macOS or Linux, activate with `source venv/bin/activate`.

## Run the server

From the **project root** (the folder that contains `app/`):

```powershell
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

You can also run it directly:

```powershell
python -m app.main
```

Open [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs) for the interactive OpenAPI UI.

## WebSocket stream

- **URL:** `ws://localhost:8000/ws/bci-stream`
- **Payload:** JSON objects with:
  - `timestamp_ms` (float): epoch ms
  - `fs` (int): sampling rate in Hz
  - `channels` (int): number of channels
  - `lfp` (`list[list[float]]`): shape `(batch_samples, channels)`
  - `spikes` (`list[list[int]]`): shape `(batch_samples, channels)` with 0/1 events

## Intent control

Set the global simulator intent (used to bias spike probabilities):

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/set-intent -ContentType "application/json" -Body '{"intent":"up"}'
```

Valid intents: `left`, `right`, `up`, `down`.

## Decoder stream

- **URL:** `ws://localhost:8000/ws/decoder`
- **Payload:** JSON objects with `timestamp_ms`, `predicted_intent`, `confidence`, `latency_ms`, `accuracy`.
- **Notes:** this endpoint reuses the simulator stream and decodes from `spikes` (LFP is generated but not used by the decoder).

## Sample client

With the server running, in another terminal from the same root:

```powershell
python tests/test_client.py
```

This connects with `websockets`, receives a handful of packets, and prints a short summary per packet (installed via `requirements.txt`).

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
│   ├── decoder.py       # minimal sliding-window decoder + bootstrap trainer
│   └── main.py          # FastAPI app + generator + /ws/bci-stream + /ws/decoder
├── tests/
│   ├── __init__.py
│   ├── test_client.py   # optional manual WebSocket smoke test
│   └── test_decoder_client.py  # optional manual decoder stream smoke test
├── requirements.txt
└── README.md
```

The `venv/` directory is created locally and is listed in `.gitignore`; it should not be committed.
