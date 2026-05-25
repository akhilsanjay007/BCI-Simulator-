# Neuralink BCI Simulator

A real-time Brain-Computer Interface simulation stack that turns synthetic neural signals into continuous cursor intent and interactive keyboard control.

This project is built to answer one question: **what would production-quality neural interface software look like before hardware is in the loop?**

---

## Why This Matters for Neuralink

I built this project around the same engineering tension that makes Neuralink compelling: neural systems are only as useful as the software that interprets them under real constraints.

High-rate signal streams are noisy. User intent changes every few milliseconds. Latency compounds across every boundary: generation, transport, decode, render. In this environment, demos are easy; robust systems are hard.

This repository focuses on that hard part:

- Designing a pipeline where velocity decode feels continuous, not jumpy
- Separating model latency from end-to-end latency so bottlenecks are explicit
- Keeping buffers bounded and failure modes observable
- Building a UI that stays responsive at stream cadence instead of re-rendering the world on every packet
- Treating reliability and instrumentation as product requirements, not afterthoughts

If your goal is assistive control that feels natural and trustworthy, these details are not optional. They are the product.

---

## What This Project Does

- Streams synthetic multi-channel LFP and spike activity in real time
- Runs a continuous decoder that emits `vx`, `vy`, `pen_down`, confidence, and accuracy metrics
- Serves WebSocket + REST APIs for dashboard control, replay, health checks, and reset workflows
- Supports optional Redis Streams buffering with retention and live buffer horizon visibility
- Renders a keyboard-first dashboard for automatic (decoder-driven) and manual control modes
- Replays recorded sessions with original timing or smoothed timing for deterministic demos

---

## Technical Highlights

### 1) Latency is split by design

The backend reports both:

- `decode_latency_ms`: model inference cost
- `end_to_end_latency_ms`: packet age at delivery

That split avoids the common trap of one opaque latency number and makes optimization work actionable.

### 2) Bounded systems over best-effort systems

Across backend and frontend, long-lived buffers are capped:

- Decoder rolling windows and accuracy deques are bounded
- Redis stream retention is time-trimmed
- Frontend signal views use fixed windows and controlled update loops

This keeps long sessions predictable and memory behavior stable.

### 3) Manual mode still uses real decode metrics

Manual control is not a fake UI bypass. It routes velocity hints through decoder prediction endpoints so confidence, latency, and accuracy remain meaningful during interaction.

### 4) Compatibility-preserving refactor for maintainability

Backend logic is organized under `app/core/` and frontend logic under `frontend/src/components`, `frontend/src/utils`, and `frontend/src/styles`, while compatibility entrypoints keep existing commands and tests stable.

---

## Architecture Snapshot

```text
NeuralSignalGenerator (app/core/simulator.py)
    -> optional Redis Streams buffer (app/core/redis_client.py)
    -> FastAPI WebSocket /ws/decoder (app/core/main.py)
    -> BciDecoder.predict (app/core/decoder.py)
    -> React dashboard (frontend/src/App.tsx + components/*)
```

### Key API Surface

- `GET /health`
- `GET /health/redis`
- `GET /api/decoder/info`
- `GET /simulator/config`
- `GET /api/recordings`
- `POST /api/recordings/select`
- `POST /api/recordings/playback`
- `POST /decoder/reset`
- `POST /manual-decoder-predict`
- `POST /manual-neural-burst`
- `WS /ws/bci-stream`
- `WS /ws/decoder`

---

## Tech Stack

### Backend

- Python 3.11
- FastAPI + Pydantic v2
- NumPy + scikit-learn
- Redis (optional, Streams buffering)

### Frontend

- React 19 + TypeScript (strict)
- Vite
- Tailwind CSS
- Canvas-based trackpad/keyboard rendering

### DevOps

- Docker + Docker Compose
- GitHub Actions CI/CD
- Railway-ready deployment config

---

## Quick Start (Local)

### 1) Backend

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
$env:PYTHONPATH = "."
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 2) Frontend

```powershell
cd frontend
npm install
npm run dev
```

### 3) Open the app

- Backend docs: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)
- Frontend: [http://127.0.0.1:5173](http://127.0.0.1:5173)

---

## Docker Compose

From repo root:

```powershell
docker compose up --build
```

Expected services:

- Backend: `http://127.0.0.1:8000`
- Frontend: `http://127.0.0.1:3000`
- Redis: `localhost:6379`

If Docker is not running, start Docker Desktop first.

---

## Environment Configuration

Copy `.env.example` to `.env` and override only what you need.

Most important variables:

- `ENV` (`development` or `production`)
- `MODEL_PATH` / `DECODER_MODEL_PATH`
- `DECODER_REGRESSOR` (`ensemble`, `rf`, `hgb`)
- `REDIS_URL`
- `REDIS_STREAM_SIGNALS`
- `REDIS_STREAM_RETENTION_SECONDS`
- `FRONTEND_URL` / `CORS_ALLOWED_ORIGINS`
- `VITE_BACKEND_URL`

---

## Validation Commands

### Backend tests

```powershell
python -m pytest tests -q
```

### Frontend checks

```powershell
cd frontend
npm run lint
npm run build
```

---

## Project Structure

```text
app/
  core/
    main.py
    simulator.py
    decoder.py
    redis_client.py
    recording_replay.py
    offline_eval.py
  main.py                (compat entrypoint)
  simulator.py           (compat export)
  decoder.py             (compat export)
  redis_client.py        (compat export)
  recording_replay.py    (compat export)
  offline_eval.py        (compat export)

frontend/src/
  components/
  hooks/
  utils/
  styles/
  App.tsx
  main.tsx
```

---

## Deployment Notes

- Railway backend start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Ensure `models/velocity_decoder.pkl` is available in production (image or mounted volume)
- If model boot should be hard-fail, set `STRICT_MODEL_LOAD=1` (otherwise backend starts with heuristic fallback)
- Set explicit CORS allow-list values for deployed frontend origins
- Set `VITE_BACKEND_URL` on the frontend service to the backend public Railway URL (browser-reachable)
- Keep Redis optional so core WebSocket behavior remains resilient during broker outages
- Track p50/p95 latency before and after hot-path changes

---

## License

MIT (or your preferred license, if updated).
