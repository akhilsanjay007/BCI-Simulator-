# neuralink-bci-sim

Synthetic neural-style signals over a WebSocket: LFP-style traces and sparse spike events, typed with Pydantic and streamed from a small **FastAPI** service. The live signal path is implemented in `app/simulator.py` (`NeuralSignalGenerator`) and consumed by `app/main.py`. Useful for prototyping decoders, dashboards, or BCI pipelines without hardware.

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

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The UI expects the decoder WebSocket at `ws://localhost:8000/ws/decoder` (start the backend first). The dashboard calls **`POST http://localhost:8000/decoder/reset`** (with CORS enabled for local Vite ports) to clear decoder buffers and session accuracy counts via **`decoder.reset_state()`**.

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

The simulator **cycles** the ground-truth intent in a fixed order: `left` → `right` → `up` → `down` → `rest`. Each intent is held for **many consecutive batches** (~20 ms per batch at default `fs=1000`; see `_INTENT_HOLD_BATCHES` in `app/simulator.py`) so that the decoder’s sliding spike window (~200 ms) mostly sees **one** label at a time—matching `offline_eval`, which evaluates long runs per intent. `rest` uses no directional channel boost. Every 50 batches the server prints a histogram of the last 200 intents to the console.

`POST /set-intent` still updates a stored `current_intent` value (valid labels: `left`, `right`, `up`, `down`, `rest`), but **live spike generation follows the cycled stream**, not this endpoint—use `/set-intent` only if you extend the app to read `current_intent` elsewhere.

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/set-intent -ContentType "application/json" -Body '{"intent":"up"}'
```

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/decoder/reset
```

## Decoder stream

- **URL:** `ws://localhost:8000/ws/decoder`
- **Payload:** JSON objects with `timestamp_ms`, `predicted_intent`, `confidence`, `latency_ms`, **`accuracy`** (rolling over the **last 20** predictions vs ground truth), **`session_accuracy`** (fraction correct since WebSocket connect or last **`decoder.reset_state()`**), plus **`cursor_x` / `cursor_y`** in \([0,1]\) for normalized 2D cursor position (integrated per connection from predicted intent in `app/main.py`; does not change `/ws/bci-stream`). Predictions may include `rest` when the model infers a neutral pattern.
- **Reset:** `POST /decoder/reset` clears the decoder’s spike window, cursor, rolling buffer, and session accuracy counters.
- **Notes:** this endpoint reuses the simulator stream and decodes from `spikes` (LFP is generated but not used by the decoder). The FastAPI app constructs `BciDecoder` with **`exploration_prob=0`** so live accuracy is comparable to **`offline_eval`** (which also uses `0`). For experiments, you can raise `exploration_prob` in `app/main.py`. For debugging, `BciDecoder.predict` **prints** feature summaries and `predicted` vs `true` intent every **50** steps to the server console.

## Offline evaluation

Run the decoder evaluation suite (no server required):

```powershell
cd neuralink-bci-sim
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
pytest tests -v
```

Or only offline metrics: `pytest tests/test_offline_eval.py -v`. Manual WebSocket scripts under `tests/` are excluded from collection via `tests/conftest.py`.

The tests exercise `app/offline_eval.py`: bootstrap training, synthetic spike batches aligned with the simulator, accuracy and confusion checks.

## Sample client

With the server running, in another terminal from the same root:

```powershell
python tests/test_client.py
```

This connects with `websockets`, receives a handful of packets, and prints a short summary per packet (installed via `requirements.txt`). Run it as a **script** (`python …`), not via `pytest`—those files are smoke tests, not the offline pytest suite.

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
│   ├── offline_eval.py  # offline metrics on synthetic spikes (no WebSocket)
│   ├── simulator.py     # NeuralSignalGenerator + shared singleton `generator`
│   └── main.py          # FastAPI app + /ws/bci-stream + /ws/decoder
├── frontend/            # React + Vite + Tailwind dashboard (optional)
│   ├── src/
│   ├── package.json
│   └── ...
├── tests/
│   ├── __init__.py
│   ├── conftest.py      # excludes manual WebSocket scripts from pytest collection
│   ├── test_client.py   # optional manual WebSocket smoke test
│   ├── test_decoder_client.py  # optional manual decoder stream smoke test
│   └── test_offline_eval.py   # pytest offline decoder evaluation
├── requirements.txt
└── README.md
```

The Python `venv/` directory and the frontend’s `node_modules/` / `dist/` are listed in `.gitignore`; they should not be committed.
