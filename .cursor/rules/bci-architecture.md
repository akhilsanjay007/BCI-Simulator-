# BCI architecture

> Read after `project.md`. Runtime flow, contracts, latency budgets, and failure behavior.

---

## 1. End-to-end flow (current)

The live dashboard path is **in-process** from generator to decoder to WebSocket. **Redis** is an **optional parallel buffer** (enabled when `REDIS_URL` is set): same packets are appended to a Streams log with **time-based retention**, without changing the decoder’s read source today.

```
┌─────────────────────────┐
│ NeuralSignalGenerator   │  app/simulator.py — shared `generator`
│ LFP + spikes + GT vel   │
└────────────┬────────────┘
             │ async batches (JSON-serializable dicts)
             ├──────────────────────────────────────┐
             │                                      │
             ▼                                      ▼
┌─────────────────────────┐            ┌──────────────────────────┐
│ Redis Streams (opt.)    │            │ FastAPI WebSocket        │
│ XADD `bci:signals` *    │            │ /ws/bci-stream (raw)       │
│ XTRIM MINID ~ (retain)  │            │ /ws/decoder (DecoderPacket)│
└─────────────────────────┘            └────────────┬─────────────┘
                                                    │
                                                    │ predict per batch
                                                    ▼
                                         ┌─────────────────────────┐
                                         │ BciDecoder              │
                                         │ window → vx, vy,        │
                                         │ pen_down, confidence, │
                                         │ cursor integrate        │
                                         └────────────┬────────────┘
                                                      │
                                                      ▼
                                         ┌─────────────────────────┐
                                         │ React App               │
                                         │ App.tsx + BCITrackpad   │
                                         │ canvas (cursor / ink)   │
                                         └─────────────────────────┘
```

**Mental model for reviewers**

- **Simulator → (optional Redis buffer) + WebSocket pipeline → continuous decoder → client**  
- Decoder consumption is still **`async for packet in generator.stream()`** inside `/ws/decoder` (`app/main.py`). A future step is a **consumer group** reading the stream and feeding decode workers; design new code so that swap stays localized.

---

## 2. Control modes

| Mode | Where | Behavior |
| --- | --- | --- |
| **Cursor** | Decoder `output_mode` + trackpad `surfaceMode: "cursor"` | Velocity drives 2D cursor; primary navigation surface. |
| **Handwriting** | Decoder `output_mode` + trackpad `surfaceMode: "handwriting"` | `pen_down` gates contact; canvas accumulates ink in normalized space; decoder/simulator GT aligned for evaluation. |

Runtime API: `POST /decoder/mode` with `{ "mode": "cursor" \| "handwriting" }` (`SetDecoderModeRequest`). Frontend should stay in sync with user-facing mode switches when testing end-to-end.

**Dashboard control** — `App.tsx`: **Automatic** (decoder packets drive cursor + pen) vs **Manual** (local velocity from keyboard / trackpad pad, synthetic burst to backend via `POST /manual-neural-burst`).

---

## 3. Data flow (steps)

1. **Generate** — Each batch: `timestamp_ms`, `fs`, `channels`, `lfp`, `spikes`; ground-truth velocity and pen state advance inside the generator for scoring.
2. **Buffer (optional)** — If Redis configured: `publish_signal_packet` → `XADD` + approximate `XTRIM` by time (`REDIS_STREAM_RETENTION_SECONDS`).
3. **Decode** — `BciDecoder.predict` on spike tensor; emits `DecoderPacket` with latency stamp, rolling/session accuracy vs GT, integrated `cursor_x` / `cursor_y`.
4. **Deliver** — `send_json` per decoded batch on `/ws/decoder`; raw stream on `/ws/bci-stream`.
5. **Render** — Client parses packets; **BCITrackpad** draws grid, cursor, strokes; charts use ring buffers / throttling — not full React tree per packet.

---

## 4. WebSocket contracts (stable surface)

### `/ws/bci-stream`

```ts
type BciStreamPacket = {
  timestamp_ms: number;
  fs: number;
  channels: number;
  lfp: number[][];
  spikes: number[][];
};
```

### `/ws/decoder` — `DecoderPacket`

```ts
type DecoderPacket = {
  timestamp_ms: number;
  vx: number;
  vy: number;
  pen_down: boolean;
  confidence: number;
  mode: "cursor" | "handwriting";
  latency_ms: number;
  accuracy: number;
  session_accuracy: number;
  cursor_x: number;
  cursor_y: number;
  num_channels: number;
};
```

**REST** — `GET /api/decoder/info`, `GET /simulator/config`, `POST /decoder/reset`, `POST /decoder/mode`, `POST /manual-neural-burst`, `GET /health`, `GET /health/redis`.

Any shape change → update Pydantic models, TS types in `App.tsx`, tests, and the changelog below.

---

## 5. Real-time targets (measured at `/ws/decoder`)

| Metric | p50 target | p95 target | Hard ceiling |
| --- | --- | --- | --- |
| `latency_ms` | ≤ 10 ms | ≤ 25 ms | 50 ms |
| Decode packet rate | ≥ 50 Hz | — | — |
| Generator batch work | ≤ 2 ms | ≤ 5 ms | 10 ms |
| Trackpad / main UI frame | ≤ 16.7 ms | ≤ 33 ms | 50 ms |

Report p50/p95 over ~30 s steady state for perf-sensitive PRs.

---

## 6. Buffering & backpressure

- **Decoder window** — fixed-duration spike deque (bounded).
- **Accuracy rolls** — bounded deque (e.g. last 20).
- **WebSocket** — one `send_json` per packet; slow clients exert backpressure (do not add unbounded outbound queues).
- **Redis stream** — retention by wall-clock via trim; stream is **not** unbounded growth.
- **Frontend** — ring buffers for charts; canvas redraw driven by layout + animation frame, not naive `setState` per network message on the whole tree.

---

## 7. Failure & recovery

| Situation | Expected behavior |
| --- | --- |
| `WebSocketDisconnect` | Log once; task ends cleanly. |
| Decode error | Log; optionally degrade packet (`confidence` low); avoid silent infinite spin. |
| Redis unavailable | Non-fatal: publish errors throttled in logs; core WS path unchanged. |
| Tab background | Skip heavy work where possible; reconnect with bounded backoff (frontend). |

---

## 8. Changelog (contract / pipeline)

- **2026-05-13** — Rules refresh: document optional Redis side-buffer from simulator; React trackpad surface (`BCITrackpad`); clarify decoder still reads in-process `generator.stream()`.
- **2026-05-11** — Continuous velocity regression (`vx`, `vy`), `pen_down`, `mode`; ensemble/RF/HGB regressors; `GET /api/decoder/info`, `POST /decoder/mode`; manual burst `{ vx, vy, duration_ms }`.
