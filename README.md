# neuralink-bci-sim



Synthetic neural-style signals over a WebSocket: LFP-style traces and sparse spike events, typed with Pydantic and streamed from a small **FastAPI** service. The live signal path is implemented in `app/simulator.py` (`NeuralSignalGenerator`) and consumed by `app/main.py`. Useful for prototyping decoders, dashboards, or BCI pipelines without hardware.



The repo includes an optional **React + Vite + Tailwind** dashboard under `frontend/` that connects to the decoder WebSocket, shows a 2D cursor, rolling decoder metrics, and a multi-channel spike raster + population firing-rate chart driven by the simulator channel count.



## Requirements



- **Backend:** Python **3.11** recommended (matches Docker images and CI); **3.10+** usually works locally. Use a virtual environment and **`requirements.txt`** — it includes the FastAPI stack, **pytest**, and **pytest-cov** (same set CI uses).

- **Dashboard (optional):** **Node.js 20+** and npm (for `frontend/`)



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



## Docker (full stack)



With **Docker Desktop** running, from the repo root:



```powershell

docker compose up --build

```



- **Backend:** [http://127.0.0.1:8000](http://127.0.0.1:8000) — FastAPI with multiple uvicorn workers (see root `Dockerfile`).

- **Frontend:** [http://127.0.0.1:3000](http://127.0.0.1:3000) — static SPA served by nginx (`frontend/Dockerfile`, `frontend/nginx.conf`).



The browser talks to the API at **`http://localhost:8000`** by default in local development. To point the built UI at another origin (e.g. the Railway backend service), set the **`VITE_BACKEND_URL`** build argument when building the frontend image or override it in `docker-compose.yml` under `frontend.build.args`.



### Redis Streams buffering (enabled by default in Docker)

The simulator publishes every raw signal packet to **Redis Streams** for low-latency buffering and multi-consumer fan-out.

- **Stream**: `bci:signals`
- **Retention**: last **20 seconds** (time-trimmed via `XTRIM ... MINID`)
- **Health**: `GET http://127.0.0.1:8000/health/redis`

Configuration (backend env vars):

- `REDIS_URL` (default in compose): `redis://redis:6379/0`
- `REDIS_STREAM_SIGNALS` (default): `bci:signals`
- `REDIS_STREAM_RETENTION_SECONDS` (default): `20`
- `REDIS_MAX_CONNECTIONS` (default): `50`



## Dashboard (optional, local dev)



With the API running on port 8000, in another terminal:



```powershell

cd neuralink-bci-sim\frontend

npm install

npm run dev

```



Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Start the backend first.



The UI uses:



| Endpoint | Purpose |

|----------|---------|

| `ws://localhost:8000/ws/decoder` | Live decoder packets (`predicted_intent`, cursor, metrics, **`num_channels`**, etc.) |

| `GET http://localhost:8000/simulator/config` | **`num_channels`** and **`fs`** (same as the generator singleton; used to size the spike raster) |

| `POST http://localhost:8000/decoder/reset` | Clears decoder buffers, cursor, and session accuracy (`decoder.reset_state()`) |

| `POST http://localhost:8000/manual-neural-burst` | Manual mode: JSON body `{ "intent", "duration_ms" }` — aligns a short cortical burst with the D-pad |
| `GET http://localhost:8000/health/redis` | Redis connectivity + stream status (or `disabled` when Redis not configured) |



CORS allows local Vite ports (`5173`, `3000`). Layout is a fixed viewport: **cursor** (primary), compact **Manual / Decoder** strip, **Raw Neural Signals** (spike raster + mean rate). For React/Vite specifics, see `frontend/README.md`.



## CI/CD



On **push** and **pull requests** to **`main`**, GitHub Actions (`.github/workflows/ci-cd.yml`) runs:



- **Backend:** `python -m pytest` with coverage over `app/`

- **Frontend:** `npm ci`, `npm run lint`, `npm run build`



On **push to `main`** only, it also builds and pushes **backend** and **frontend** images to **GHCR** (`ghcr.io/<owner>/<repo>/backend` and `…/frontend`, tags `:latest` and `:<git-sha>`). Image paths sanitize trailing **`.`** or **`-`** on owner/repo segments so Docker accepts them (GitHub repo names may end with punctuation that OCI rejects).



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

- **Payload:** JSON objects with:

  - `timestamp_ms`, `predicted_intent`, `confidence`, `latency_ms`

  - **`accuracy`** — rolling over the **last 20** predictions vs ground truth

  - **`session_accuracy`** — fraction correct since WebSocket connect or last **`decoder.reset_state()`**

  - **`cursor_x` / `cursor_y`** — normalized \([0,1]\) 2D cursor (integrated from predicted intent)

  - **`num_channels`** — electrode count for the simulator/decoder configuration (dashboard raster uses `min(64, num_channels)` visible rows)

- **Reset:** `POST /decoder/reset` clears the decoder’s spike window, cursor, rolling buffer, and session accuracy counters.

- **Notes:** this endpoint reuses the simulator stream and decodes from `spikes` (LFP is generated but not used by the decoder). The FastAPI app constructs `BciDecoder` with **`exploration_prob=0`** so live accuracy is comparable to **`offline_eval`** (which also uses `0`). For experiments, you can raise `exploration_prob` in `app/main.py`. For debugging, `BciDecoder.predict` **prints** feature summaries and `predicted` vs `true` intent every **50** steps to the server console.



## Offline evaluation



Run the decoder evaluation suite (no server required):



```powershell

cd neuralink-bci-sim

.\venv\Scripts\Activate.ps1

pip install -r requirements.txt

$env:PYTHONPATH = "."

python -m pytest tests -v

```



With coverage (matches CI):



```powershell

python -m pytest tests/ --cov=app --cov-report=term-missing

```



Or only offline metrics: `python -m pytest tests/test_offline_eval.py -v`. Manual WebSocket scripts under `tests/` are excluded from collection via `tests/conftest.py`.



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

│   ├── decoder.py       # sliding-window decoder + bootstrap trainer + DecoderPacket

│   ├── offline_eval.py  # offline metrics on synthetic spikes (no WebSocket)

│   ├── simulator.py     # NeuralSignalGenerator + shared singleton `generator`

│   └── main.py          # FastAPI: /ws/bci-stream, /ws/decoder, /simulator/config, etc.

├── frontend/            # React + Vite + Tailwind dashboard (optional)

│   ├── Dockerfile

│   ├── nginx.conf

│   ├── src/

│   ├── package.json

│   └── ...

├── tests/

│   ├── __init__.py

│   ├── conftest.py      # excludes manual WebSocket scripts from pytest collection

│   ├── test_client.py   # optional manual WebSocket smoke test

│   ├── test_decoder_client.py  # optional manual decoder stream smoke test

│   └── test_offline_eval.py   # pytest offline decoder evaluation

├── .github/

│   └── workflows/

│       └── ci-cd.yml    # pytest + coverage; frontend lint/build; GHCR images on main

├── Dockerfile           # production backend image (uvicorn, multi-worker)

├── docker-compose.yml    # backend + frontend + redis (Streams buffer)

├── requirements.txt

└── README.md

```



The Python `venv/` directory and the frontend’s `node_modules/` / `dist/` are listed in **`.gitignore`**; they should not be committed.


