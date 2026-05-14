# Project — neuralink-bci-sim

> Read first. Source of truth for intent, stack, and quality bar.  
> `bci-architecture.md`, `agents.md`, and `project-tree.md` extend this file.

---

## 1. Goal

Ship a **real-time BCI simulator + continuous velocity decoder + dashboard** that reads like **Neuralink Software Engineering Intern** work: tight latency story, honest metrics, production-shaped code.

**What the product does**

- **Synthetic neural stream** — LFP + multi-channel spike batches at implant-scale sample rates (`app/simulator.py`).
- **Continuous velocity decoder** — sliding spike window → `(vx, vy)` regression, EMA-smoothed confidence, server-side cursor integration, optional `pen_down` semantics for handwriting (`app/decoder.py`).
- **Handwriting + cursor trackpad** — single high-signal canvas: normalized cursor, velocity HUD, cursor vs handwriting surface modes, ink strokes (`frontend/src/BCITrackpad.tsx`).
- **Redis Streams buffering** — when `REDIS_URL` is set, each simulator packet is **XADD**’d to a time-trimmed stream (default `bci:signals`) for bounded retention and future fan-out (`app/redis_client.py`, wired from `NeuralSignalGenerator.stream()`).

**Audience**

- Reviewers who care about **smooth control**, **bounded memory**, **observable failure**, and **clean boundaries** — not feature count.

**Non-goals**

- Clinical claims, arbitrary model zoos, or UI chrome that does not improve decode UX, latency visibility, or evaluation rigor.

---

## 2. Tech stack (respect unless changing deliberately)

| Layer | Choice |
| --- | --- |
| Backend | Python **3.11**, FastAPI, Pydantic v2, uvicorn |
| ML / numerics | NumPy, scikit-learn (RF / HGB / ensemble via `DECODER_REGRESSOR`) |
| Real-time transport | WebSockets (`/ws/bci-stream`, `/ws/decoder`) |
| Buffering / broker hook | **redis** 5.x async, Streams + `XTRIM MINID ~` retention |
| Frontend | **React 19** + TypeScript (strict) + Vite + Tailwind |
| Tests | `pytest` + `pytest-cov` (backend); ESLint + `tsc -b` + Vite build (frontend) |
| Deploy | Docker (multi-stage), GitHub Actions → GHCR, `railway.toml` for hosted demos |

Pinned versions live in `requirements.txt` and `frontend/package.json`. Do not bump majors in unrelated changes.

**Artifacts**

- Shipped / default decoder weights: `models/velocity_decoder.pkl` (load via `MODEL_PATH` / `DECODER_MODEL_PATH` in production).

---

## 3. Quality expectations (Neuralink-style)

1. **Smoothness** — cursor and ink should feel continuous at the UI frame budget; avoid per-packet React churn on hot surfaces (trackpad, raster).
2. **Reliability** — long sessions without leaks; every long-lived buffer has a cap; WebSockets clean up on unmount / disconnect.
3. **Clean code** — typed boundaries (Pydantic + TS mirrors), small modules, vectorized hot paths in Python, no blocking I/O in `async def`.
4. **Observability** — `latency_ms`, accuracy rolls, connection state visible without DevTools; backend logs gated (e.g. every N batches on `/ws/decoder`).

---

## 4. Performance goals (soft real-time)

Targets are defined in `bci-architecture.md`. Any hot-path PR should cite **before / after** `latency_ms` (p50 / p95 over ~30 s steady state) when behavior or cost changes.

---

## 5. Coding standards (short)

**Python** — Type public APIs; Pydantic for wire models; `black` + `ruff`; `asyncio` pacing only; explicit `WebSocketDisconnect`; NumPy vectorization in generator/decoder inner loops; no unbounded queues.

**TypeScript** — Strict; mirror `DecoderPacket` and REST shapes; `useEffect` WS lifecycle with cleanup; `requestAnimationFrame` or throttled ticks for motion/ink; Tailwind-first.

**Contracts** — Changing `DecoderPacket` or stream JSON requires coordinated backend + frontend + tests + `bci-architecture.md` changelog.

---

## 6. Testing & git

- Touching `app/decoder.py`, `app/simulator.py`, `app/main.py`, or `app/redis_client.py` → add or update `tests/` coverage where meaningful.
- Manual WebSocket scripts stay excluded from pytest via `tests/conftest.py`.
- Conventional Commits; one logical change per PR; squash-merge to `main`.

---

## 7. Hard rules

- Do not block the event loop (`time.sleep`, sync network/filesystem in async handlers).
- Do not change wire types without updating all consumers and architecture docs.
- Do not commit secrets, `venv/`, `node_modules/`, build artifacts, or disable CI to merge.
