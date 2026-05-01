# neuralink-bci-sim

Synthetic neural-style signals over a WebSocket: LFP-style traces and sparse spike events, typed with Pydantic and streamed from a small **FastAPI** service. Useful for prototyping decoders, dashboards, or BCI pipelines without hardware.

The repo also includes an optional **React + Vite** dashboard under `frontend/` that connects to `ws://localhost:8000/ws/decoder` and shows live decoder output.

## Requirements

- **Backend:** Python 3.10 or newer (3.13 is fine), a virtual environment (recommended), and dependencies in `requirements.txt`
- **Dashboard (optional):** [Node.js](https://nodejs.org/) 20+ and npm (for `frontend/`)

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

## Dashboard (optional)

With the API running on port 8000, in another terminal:

```powershell
cd neuralink-bci-sim\frontend
npm install
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The UI expects the decoder WebSocket at `ws://localhost:8000/ws/decoder` (start the backend first).

For Vite/React-specific details, see `frontend/README.md`.

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
├── frontend/            # React + Vite + Tailwind dashboard (optional)
│   ├── src/
│   ├── package.json
│   └── ...
├── tests/
│   ├── __init__.py
│   ├── test_client.py   # optional manual WebSocket smoke test
│   └── test_decoder_client.py  # optional manual decoder stream smoke test
├── requirements.txt
└── README.md
```

The Python `venv/` directory and the frontend’s `node_modules/` / `dist/` are listed in `.gitignore`; they should not be committed.
