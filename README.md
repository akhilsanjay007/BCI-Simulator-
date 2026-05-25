# neuralink-bci-sim

Synthetic neural-style signals over WebSocket (LFP traces + sparse spikes), a trained **velocity decoder**, and a **React** dashboard with a virtual-keyboard trackpad (Automatic decoder control + Manual pointer/keys)—without implant hardware.

| Component | Role |
|-----------|------|
| `app/simulator.py` | `NeuralSignalGenerator` — ground-truth velocity + channel spikes; optional recording replay |
| `app/recording_replay.py` | Load `recordings/*.json` and drive cursor `(x, y)` + `clicked` → `pen_down` |
| `app/decoder.py` | Sliding-window `BciDecoder` — `vx`/`vy`, pen-down, cursor integration |
| `app/redis_client.py` | Optional Redis Streams buffer (`bci:signals`, ~20s retention) |
| `app/main.py` | FastAPI — REST, `/ws/bci-stream`, `/ws/decoder`, recording APIs |
| `frontend/` | Vite + React + Tailwind BCI dashboard (`BCITrackpad`, keyboard layout) |
| `recordings/` | Saved trackpad sessions (`demo_*.json`, `session_*.json`) for Automatic replay |

## Requirements

- **Backend:** Python **3.11** (matches Docker/CI); **3.10+** usually works locally
- **Dashboard (optional):** Node.js **20+** and npm
- **Production weights:** Git **LFS** for `models/velocity_decoder.pkl` (~2 GB)
- **Full stack (optional):** Docker Desktop for `docker compose`

## Quick start (local)

```powershell
cd neuralink-bci-sim
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
git lfs install
git lfs pull
$env:PYTHONPATH = "."
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Open [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

**Dashboard** (second terminal):

```powershell
cd frontend
npm install
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) with the API on port 8000.

Copy [`.env.example`](.env.example) to `.env` if you need custom Redis or CORS origins.

### Python dependencies

| File | Use |
|------|-----|
| [`requirements.txt`](requirements.txt) | Production runtime (Docker/Railway image) |
| [`requirements-dev.txt`](requirements-dev.txt) | Local dev + CI (`pytest`, `pytest-cov`) |

## Git LFS (velocity decoder)

Weights live at **`models/velocity_decoder.pkl`** and are tracked with Git LFS.

```powershell
git lfs install
git lfs pull
```

**Retrain** (from repo root, venv active):

```powershell
$env:PYTHONPATH = "."
python -m app.offline_eval --retrain --artifact models/velocity_decoder.pkl
```

Commit and push via LFS when updating production weights.

## Docker (full stack)

With Docker running, from the repo root (run **`git lfs pull`** first so `models/` is not a pointer stub):

```powershell
docker compose up --build
```

| Service | URL | Notes |
|---------|-----|--------|
| Backend | [http://127.0.0.1:8000](http://127.0.0.1:8000) | FastAPI, 4 uvicorn workers |
| Frontend | [http://127.0.0.1:3000](http://127.0.0.1:3000) | nginx static SPA |
| Redis | `localhost:6379` | Streams buffer for raw packets |

`docker compose` bind-mounts `./recordings` → `/app/recordings` so demo/session JSON is available without rebuilding the backend image.

The frontend image is built with `VITE_BACKEND_URL=http://localhost:8000` (see `docker-compose.yml` `frontend.build.args`). Change this when the browser must call a different API origin.

## Dashboard

Two-column layout: decoder metrics + neural charts (left), virtual-keyboard trackpad + **Thought → Text** (right).

- **Manual** — pointer/keys on the canvas trackpad keep direct feel while `(vx, vy, pen_down)` is sent to `POST /manual-decoder-predict` so confidence/latency/accuracy are real decoder outputs
- **Automatic** — live `/ws/decoder` drives cursor + `pen_down` (key select / click on the QWERTY keyboard)
- **Recording replay** (Automatic only) — header dropdown picks any `recordings/*.json`; timing **Original** (recorded timestamps) or **Smooth 125 Hz** (8 ms resample)
- **Thought → Text** — typed output from BCI cursor on the keyboard; **Clear** / **Reset cursor**
- **Decoder metrics** — confidence, latency, signal quality, velocity, session stats
- **Neural signals** — multi-channel raster sized from `num_channels`

### Recording trackpad sessions (optional)

Record from the same `/ws/decoder` stream consumed by `frontend/src/App.tsx` so replay timing mirrors real app behavior:

```powershell
$env:PYTHONPATH = "."
python recordings/record_from_app.py --ws-url ws://localhost:8000/ws/decoder
```

This saves `recordings/session_YYYYMMDD_HHMMSS.json` with normalized `x`, `y`, `timestamp_ms`, and `clicked`.

To re-record shipped demos:

```powershell
python recordings/record_from_app.py --output demo_1.json --session-id demo_1 --typed-text "YOUR DEMO 1 TEXT"
python recordings/record_from_app.py --output demo_2.json --session-id demo_2 --typed-text "YOUR DEMO 2 TEXT"
```

The recorder enforces strictly increasing timestamps, which avoids fixed-step fallback and jitter during replay.

### API used by the UI

| Endpoint | Purpose |
|----------|---------|
| `ws://…/ws/decoder` | Live `DecoderPacket` JSON; `type: "decoder_reset"` on reset |
| `GET /api/decoder/info` | Regressor, `fs_hz`, `n_features`, training status |
| `GET /simulator/config` | `num_channels`, `fs`, `replay_active`, `selected_recording_id` |
| `GET /api/recordings` | List `recordings/*.json` metadata for the replay dropdown |
| `POST /api/recordings/select` | `{ "recording_id", "timing": "original" \| "smooth_125hz" }` — switch replay + decoder reset |
| `POST /decoder/reset` | Clears decoder + Redis stream; broadcasts reset to WS clients |
| `POST /manual-decoder-predict` | `{ "vx", "vy", "pen_down", "batch_samples" }` — manual-mode decode tick returning real `DecoderPacket` metrics |
| `POST /manual-neural-burst` | `{ "vx", "vy", "duration_ms" }` — manual-mode cortical burst |
| `GET /health` | Liveness + decoder/simulator summary |
| `GET /health/redis` | Redis ping or `disabled` |

CORS allows local Vite (`5173`, `3000`) and origins from `FRONTEND_URL` / `CORS_ALLOWED_ORIGINS`, plus `*.up.railway.app` when `ENV=production`.

Frontend build-time variable: **`VITE_BACKEND_URL`** (required for production builds outside dev proxy).

## Deployment

### Pre-flight checklist

1. **`git lfs pull`** on the machine or CI checkout that builds the backend image.
2. Confirm **`models/velocity_decoder.pkl`** is a real file (not an LFS pointer) in the build context.
3. Set **`ENV=production`** on the backend so a missing model fails fast.
4. Set **`VITE_BACKEND_URL`** to the public HTTPS API URL when building the frontend image.
5. Set **`FRONTEND_URL`** (or `CORS_ALLOWED_ORIGINS`) on the backend to the public SPA origin(s).
6. Provision **Redis** for production buffering (`REDIS_URL`) or accept disabled Redis (no stream buffer).

### Backend (Docker / Railway)

Root [`Dockerfile`](Dockerfile): Python 3.11, `pip install -r requirements.txt`, `git lfs pull` for `models/`, uvicorn with 4 workers.

[`railway.toml`](railway.toml) uses that Dockerfile and **`GET /health`** for deploy checks.

| Variable | Purpose |
|----------|---------|
| `ENV` | `production` — require trained artifact; no bootstrap fallback |
| `MODEL_PATH` | Override pickle path (wins over `DECODER_MODEL_PATH`) |
| `DECODER_MODEL_PATH` | Legacy alias for model path |
| `DECODER_REGRESSOR` | `ensemble` (default), `rf`, or `hgb` — must match training |
| `REDIS_URL` | e.g. `redis://…` — omit to disable Streams client |
| `REDIS_STREAM_SIGNALS` | Stream name (default `bci:signals`) |
| `REDIS_STREAM_RETENTION_SECONDS` | Trim window (default `20`) |
| `FRONTEND_URL` / `CORS_ALLOWED_ORIGINS` | Allowed browser origins (comma-separated) |
| `BCI_REPLAY` | Set `0` / `false` / `off` to disable startup replay (default: on when JSON exists) |
| `BCI_RECORDINGS_DIR` | Directory for `*.json` sessions (default `recordings/` at repo root; Docker: `/app/recordings`) |
| `BCI_RECORDING_PATH` | Force a single JSON file at startup (overrides directory scan) |

### Frontend (Docker / Railway)

[`frontend/Dockerfile`](frontend/Dockerfile): `npm ci` → `npm run build` → nginx on port 80.

Build arg **`VITE_BACKEND_URL`** must be the browser-reachable API base (e.g. `https://your-api.up.railway.app`), **no** trailing slash.

### Railway (two services + Redis)

1. **Backend** — repo root, `Dockerfile`, variables above, health path `/health`.
2. **Redis** — Railway Redis plugin or external URL → `REDIS_URL` on backend.
3. **Frontend** — root `frontend/`, `frontend/Dockerfile`, build arg `VITE_BACKEND_URL` = backend public URL, set backend `FRONTEND_URL` to frontend public URL.

#### Optional: volume for decoder weights (~2 GB)

Use a Railway volume when you do **not** want the pickle baked into every image build (or to update weights without redeploying).

| Setting | Value |
|---------|--------|
| Volume name | `decoder-model` (any name is fine) |
| Mount path | **`/app/models`** |
| Expected file | `/app/models/velocity_decoder.pkl` (default `MODEL_PATH`; no env change needed) |

**Railway UI:** open the backend service → **Volumes** → create volume → mount at **`/app/models`**.

Volumes are **not** configurable in `railway.toml` today; use the dashboard (or a template).

After mount, copy `velocity_decoder.pkl` onto the volume (the mount **replaces** the image’s `models/` directory at runtime). Set **`RAILWAY_RUN_UID=0`** on the backend so the non-root `app` user can read the volume (Railway mounts volumes as root).

```text
ENV=production
RAILWAY_RUN_UID=0
```

`RAILWAY_VOLUME_MOUNT_PATH` is set automatically when a volume is attached; default artifact resolution still uses `models/velocity_decoder.pkl` under `/app`.

### GHCR images (CI)

On push to **`main`**, [`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml) publishes:

- `ghcr.io/<owner>/<repo>/backend:latest` and `:<sha>`
- `ghcr.io/<owner>/<repo>/frontend:latest` and `:<sha>`

Pull requests run pytest + frontend lint/build only (no image push).

## WebSocket streams

### Raw simulator — `ws://host/ws/bci-stream`

JSON per batch: `timestamp_ms`, `fs`, `channels`, `lfp`, `spikes`.

### Decoder — `ws://host/ws/decoder`

JSON per step: `timestamp_ms`, `vx`, `vy`, `pen_down`, `confidence`, `decode_latency_ms`, `end_to_end_latency_ms`, `redis_buffer_seconds`, `accuracy`, `session_accuracy`, `cursor_x`, `cursor_y`, `num_channels`.

When replay is active, the server overrides `vx`, `vy`, `pen_down`, `cursor_x`, and `cursor_y` from the selected recording so the UI matches saved cursor motion.

Reset broadcast: `{ "type": "decoder_reset", "cursor_x", "cursor_y", "num_channels", … }`.

## Velocity ground truth

**Live (no recording):** the simulator holds piecewise-constant targets `(vx, vy)` for ~1 s segments; `pen_down` follows decode-style speed thresholds.

**Recording replay:** ground truth comes from interpolated samples in `recordings/*.json` (`x`, `y`, `clicked` → velocity + `pen_down`). Channel firing uses `velocity_spike_multipliers` in `app/decoder.py`.

## Tests and offline evaluation

```powershell
pip install -r requirements-dev.txt
$env:PYTHONPATH = "."
python -m pytest tests/ --cov=app --cov-report=term-missing
```

Retrain + evaluate: `python -m app.offline_eval --retrain --artifact models/velocity_decoder.pkl`

Manual smoke scripts (not collected by pytest): `python tests/test_client.py`, `python tests/test_decoder_client.py`.

## Project layout

```
neuralink-bci-sim/
├── app/
│   ├── main.py              # FastAPI app
│   ├── simulator.py         # NeuralSignalGenerator
│   ├── recording_replay.py  # recordings/*.json replay driver
│   ├── decoder.py           # BciDecoder + artifacts
│   ├── redis_client.py      # Redis Streams
│   └── offline_eval.py      # Training / metrics
├── recordings/              # demo_*.json, session_*.json (replay source)
├── frontend/                # React dashboard
├── models/                  # velocity_decoder.pkl (Git LFS)
├── tests/
├── Dockerfile               # Backend image
├── docker-compose.yml       # backend + frontend + redis
├── railway.toml
├── requirements.txt         # Production Python deps
├── requirements-dev.txt     # + pytest for dev/CI
├── .env.example
└── README.md
```

`venv/`, `frontend/node_modules/`, and `frontend/dist/` are gitignored.
