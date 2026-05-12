# BCI Architecture

> Read after `project.md`. Defines the runtime data flow, real-time budgets, and the
> contract every component must respect.

---

## 1. High-Level Architecture (Text Diagram)

### Current (in-process pipeline)

```
        ┌──────────────────────────┐
        │  NeuralSignalGenerator   │   app/simulator.py
        │  (LFP + spike events,    │   shared singleton `generator`
        │   cycled ground-truth    │
        │   intent every N batches)│
        └────────────┬─────────────┘
                     │  np.ndarray  (batch_samples, channels)
                     │  ~20 ms per batch @ fs=1000 Hz
                     ▼
        ┌──────────────────────────┐
        │   FastAPI WebSocket      │   app/main.py
        │   /ws/bci-stream         │── raw signal consumers (debug, clients)
        │   /ws/decoder            │
        └────────────┬─────────────┘
                     │  spikes window (~200 ms sliding)
                     ▼
        ┌──────────────────────────┐
        │       BciDecoder         │   app/decoder.py
        │  features → sklearn RFR │
        │  → vx, vy, pen_down,    │
        │    confidence, cursor   │
        │  → DecoderPacket        │
        └────────────┬─────────────┘
                     │  JSON DecoderPacket
                     │  per batch (~50 Hz)
                     ▼
        ┌──────────────────────────┐
        │   React Dashboard        │   frontend/src/App.tsx
        │   - Cursor (primary)     │   + NeuralSignalCharts.tsx
        │   - Manual / Decoder bar │   + cursorPhysics.ts
        │   - Spike raster + rate  │
        └──────────────────────────┘
```

### Planned (broker-backed, multi-consumer)

```
   Simulator ──► Redis Streams (`bci.signal`)  ──► Decoder worker(s) ──► Redis Streams (`bci.decoder`)
                                                                          │
                                                                          ▼
                                                                FastAPI WS fan-out  ──► Frontend(s)
                                                                          │
                                                                          ▼
                                                                Optional metrics sink
                                                                (Prometheus / Loki)
```

Redis is already stubbed in `docker-compose.yml`. It is **not yet wired in**. Treat the broker
section as design intent, not as code-in-place.

---

## 2. Data Flow (Step by Step)

1. **Generation** — `NeuralSignalGenerator.stream()` yields batches with:
   - `lfp`: `list[list[float]]` shape `(batch_samples, channels)`
   - `spikes`: binary events `(batch_samples, channels)`, values `{0, 1}`
   - Ground-truth **continuous velocity** `(current_target_vx, current_target_vy)` in `[-1, 1]`
     and `current_stream_pen_down` is held for `_VELOCITY_HOLD_BATCHES` so the decoder window
     mostly sees one target at a time.

2. **Transport (current)** — `app/main.py` has two WebSocket endpoints:
   - `/ws/bci-stream` — raw signal packets (`timestamp_ms`, `fs`, `channels`, `lfp`, `spikes`).
   - `/ws/decoder` — decoded packets (`DecoderPacket`).

3. **Decoding** — `BciDecoder` maintains a sliding spike window (~200 ms), extracts features
   per channel, runs a **RandomForestRegressor** on `(vx, vy)`, applies EMA smoothing and
   inter-tree agreement → `confidence`, integrates cursor, and emits a `DecoderPacket`:
   ```
   {
     timestamp_ms, vx, vy, pen_down, confidence, mode,
     latency_ms, accuracy, session_accuracy,
     cursor_x, cursor_y,
     num_channels
   }
   ```
   `accuracy` / `session_accuracy` are velocity-alignment scores in `[0, 1]` vs simulator
   ground truth. `exploration_prob=0` in production WS path so live numbers are comparable to
   `offline_eval`.

4. **Frontend** — `App.tsx` opens both WebSockets, throttles render updates, and drives:
   - 2D cursor (`cursorPhysics.ts`) — primary surface
   - Manual / Decoder strip — confidence, accuracy, latency
   - `NeuralSignalCharts.tsx` — spike raster (`min(64, num_channels)` rows) + mean firing rate

5. **Reset** — `POST /decoder/reset` clears decoder buffers, cursor, rolling counters.

---

## 3. WebSocket Contracts (Stable)

### `/ws/bci-stream` — raw signal

```ts
type BciStreamPacket = {
  timestamp_ms: number;
  fs: number;             // Hz
  channels: number;
  lfp: number[][];        // (batch_samples, channels)
  spikes: number[][];     // (batch_samples, channels), 0|1
};
```

### `/ws/decoder` — decoder output (`DecoderPacket`)

```ts
type DecoderPacket = {
  timestamp_ms: number;
  vx: number;              // [-1, 1] horizontal velocity intent
  vy: number;              // [-1, 1] vertical (+y down)
  pen_down: boolean;
  confidence: number;      // [0, 1]
  mode: "cursor" | "handwriting";
  latency_ms: number;      // end-to-end decode latency
  accuracy: number;        // rolling velocity score, last 20
  session_accuracy: number; // since reset/connect
  cursor_x: number;        // [0, 1]
  cursor_y: number;        // [0, 1]
  num_channels: number;
};
```

**REST:** `GET /api/decoder/info` returns model type, `decoder_mode`, `fs_hz`, `n_features`, etc.

**These shapes are part of the public surface.** Any change requires:
- Backend Pydantic model update
- Frontend TypeScript type update
- Test update
- A note in this file's changelog section

---

## 4. Real-Time Requirements & Latency Goals

The system is **soft real-time**. Targets are measured at the `/ws/decoder` boundary.

| Metric                                | Target (p50) | Target (p95) | Hard ceiling |
| ------------------------------------- | ------------ | ------------ | ------------ |
| End-to-end decode latency (`latency_ms`) | ≤ 10 ms      | ≤ 25 ms      | 50 ms        |
| Decoder packet rate                   | ≥ 50 Hz      | —            | —            |
| Per-batch generation cost             | ≤ 2 ms       | ≤ 5 ms       | 10 ms        |
| Frontend render frame                 | ≤ 16.7 ms    | ≤ 33 ms      | 50 ms        |
| WebSocket reconnect time              | ≤ 1 s        | ≤ 2 s        | 5 s          |

If any of these regress, the PR must call it out and either fix it or document why it's acceptable.

### Measurement

- Backend stamps `timestamp_ms` at packet send and computes `latency_ms` from generation start.
- Frontend can log inter-arrival jitter; a small "metrics strip" already shows latency live.
- For perf PRs, use a 30-second steady-state window and report p50 / p95 / p99.

---

## 5. Buffering Strategy

- **Generator:** stateless per-call apart from intent cycling and RNG state. No queue inside.
- **Decoder window:** fixed-size deque of recent spike batches (~200 ms worth). Bounded.
- **WebSocket send:** one `await ws.send_json(...)` per produced packet. **No outbound queue** —
  if the consumer is slow, FastAPI applies natural backpressure on `send_json`.
- **Rolling accuracy buffer:** `collections.deque(maxlen=20)`. Bounded.
- **Frontend chart buffers:** ring buffers (`useRef` arrays with a head index), capped at the
  visible window size. Never grow unbounded.

**Rule:** every long-lived buffer must have a `maxlen` or equivalent cap. Memory should be
flat over a 1-hour session.

---

## 6. Failure Modes & Recovery

| Failure                          | Behavior                                                                  |
| -------------------------------- | ------------------------------------------------------------------------- |
| Client disconnects mid-stream    | Server catches `WebSocketDisconnect`, logs once, releases task            |
| Decoder raises during predict    | Log with packet index, send last-known intent w/ `confidence=0`, continue |
| Slow consumer                    | Backpressure via `await send_json`; do **not** buffer unboundedly         |
| Frontend tab backgrounded        | WS stays open; charts skip frames; on focus, snap to latest packet only   |
| Server restart                   | Frontend retries WS with exponential backoff (cap 2 s)                    |

---

## 7. Future Extensibility

These are explicit, intentional next steps. Build new code so they're cheap to add later.

1. **Closed-loop feedback** — frontend (or an env model) emits user actions back to the
   simulator, which modulates the next batch's spike distributions. Reserve a `/ws/feedback`
   endpoint name; do not collide with it.

2. **Multi-channel scaling** — currently `num_channels` is small (tens). Generator and
   decoder should remain `O(channels)` per batch and never iterate channels in pure Python.
   Use vectorized NumPy throughout. Target: 256–1024 channels without code changes.

3. **Redis-backed fan-out** — replace the in-process pipeline with Redis Streams so multiple
   decoder workers and multiple frontends can subscribe. Stream names: `bci.signal`,
   `bci.decoder`. Consumer groups per service.

4. **Pluggable decoders** — abstract `BciDecoder` behind a `Decoder` protocol with
   `predict(window) -> DecoderPacket`. Allow swapping in a PyTorch model without touching
   `main.py`.

5. **Persistent sessions** — record raw signal + decoder output to disk for replay and
   offline evaluation. Reuse the existing `offline_eval.py` harness.

6. **Observability stack** — Prometheus metrics endpoint (`/metrics`) for latency histograms,
   packet rates, and decoder accuracy; Grafana dashboard mirroring the React UI.

7. **Auth & multi-user** — token-protected WS, per-user simulator instances. Out of scope
   for v1 but plan endpoint paths to be user-scoped (`/ws/decoder` → `/ws/users/{id}/decoder`).

---

## 8. Changelog (append on every contract change)

- **2026-05-11** — Replaced discrete `predicted_intent` with continuous velocity regression:
  `vx`, `vy`, `pen_down`, `mode`; decoder model is `RandomForestRegressor`; added
  `GET /api/decoder/info` and `POST /decoder/mode`.
- **2026-05-11 (handwriting branch)** — Simulator uses ring population coding + linearly
  interpolated velocity segments; `POST /manual-neural-burst` body is `{ vx, vy, duration_ms }`
  (removed `/set-intent` and discrete 5-class labels). `predict_velocity` returns only
  `(vx, vy)`; training entry point is `generate_training_data()`.
