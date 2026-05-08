# Project — neuralink-bci-sim

> Read this file first. It is the source of truth for project intent, stack, and standards.
> Other rules (`bci-architecture.md`, `agents.md`, `project-tree.md`) build on top of it.

---

## 1. Project Goal

A **real-time Brain–Computer Interface (BCI) Signal Simulator + ML Decoder Dashboard**.

- Backend streams synthetic neural signals (LFP + spike events) over WebSocket.
- A sliding-window decoder predicts user intent (`left`, `right`, `up`, `down`, `rest`) and drives a 2D cursor.
- A React dashboard visualizes raw signals, decoder output, and live metrics (accuracy, latency, throughput).
- Everything runs locally via `uvicorn` + `npm run dev`, or as a full stack via `docker compose up`.

**Target audience:** Neuralink Software Engineering Internship review.
The bar is: *"Would a Neuralink staff engineer be comfortable shipping this?"*

### Non-Goals

- Not a clinical-grade decoder. Not a model zoo. Not a research playground.
- Do not add features that don't improve **latency, reliability, observability, UX, or evaluation rigor**.

---

## 2. Tech Stack (Do Not Change Without Discussion)

| Layer            | Choice                                                              |
| ---------------- | ------------------------------------------------------------------- |
| Backend          | Python **3.11**, FastAPI, Pydantic v2, `uvicorn[standard]`          |
| Real-time        | WebSockets (FastAPI native)                                         |
| Numerics / ML    | NumPy, scikit-learn (PyTorch allowed only for explicit upgrades)    |
| Frontend         | React 18 + TypeScript (strict) + Vite + Tailwind                    |
| Tests            | `pytest` + `pytest-cov` (backend), ESLint + `tsc --noEmit` (FE)     |
| Container        | Docker, multi-stage; nginx for static frontend                      |
| CI/CD            | GitHub Actions → GHCR (`backend` and `frontend` images)             |
| Future broker    | Redis (stub already in `docker-compose.yml`, not yet wired in)      |

### Pinned versions

See `requirements.txt` and `frontend/package.json`. Do **not** bump major versions in unrelated PRs.

---

## 3. Coding Standards

### 3.1 Python (Backend)

- **Type everything.** Public functions, return types, dataclasses, Pydantic models. `mypy --strict` is the aspiration.
- **Pydantic v2** for all wire types (`DecoderPacket`, request/response bodies). Never hand-roll JSON dicts on the boundary.
- **Format / lint:** `black` + `ruff`. No unused imports, no `# noqa` without a reason.
- **Naming:** `snake_case` functions/variables, `PascalCase` classes, `SCREAMING_SNAKE_CASE` constants. Module names are short and lowercase (`decoder.py`, `simulator.py`).
- **Error handling:**
  - Never `except:` or `except Exception:` without re-raising or logging with context.
  - On WebSocket loops, catch `WebSocketDisconnect` explicitly; everything else logs + closes gracefully.
  - Validate inputs at the edge (Pydantic), trust them inside.
- **Performance:**
  - Hot path (per-batch generation, decode, send) must be **allocation-light**: prefer pre-allocated NumPy arrays and `np.ndarray` ops over Python loops.
  - No blocking I/O inside `async def`. Use `await asyncio.sleep(...)` for pacing, never `time.sleep`.
  - Log latency in milliseconds with at least 1 decimal place (`f"{x:.1f} ms"`).

### 3.2 TypeScript (Frontend)

- **Strict mode on.** No `any` without a `// TODO(type):` comment and a tracking note.
- **Types live with the code that owns them**; for the WebSocket contract, mirror the backend's `DecoderPacket` exactly (field names, units, optionality).
- **React:**
  - Functional components + hooks only.
  - WebSocket lifecycle goes through `useEffect` with proper cleanup (`socket.close()` on unmount).
  - Heavy renders (rasters, charts) must use `useMemo` / `useRef` and avoid re-renders per packet — batch/throttle to ~30–60 FPS.
- **Styling:** Tailwind utility-first. No inline styles except for dynamic numeric values (positions, widths). Keep class lists readable; extract to small components when they get noisy.
- **Lint:** `npm run lint` must pass. `npm run build` must pass (this is what CI runs).

### 3.3 Naming Conventions (cross-stack)

- WebSocket endpoints: `/ws/<noun>` (`/ws/bci-stream`, `/ws/decoder`).
- REST endpoints: `/<resource>/<action>` or `/<resource>` (`/simulator/config`, `/decoder/reset`, `/set-intent`).
- Time fields end in their unit: `timestamp_ms`, `latency_ms`, `duration_ms`.
- Counters/rates are explicit: `num_channels`, `fs` (Hz), `accuracy` ∈ [0, 1].

### 3.4 Performance & Real-Time Discipline

- The system has **soft real-time** requirements. See `bci-architecture.md` for exact targets.
- Every PR that touches the hot path must report **before/after latency** in the description (use `latency_ms` from `/ws/decoder` over a 30 s window).
- Buffers are bounded. Never use unbounded `list.append` in long-running loops.
- Prefer **deterministic** behavior under tests — seed RNGs, freeze time where possible.

### 3.5 Observability

- Server logs: structured-ish lines with a clear prefix (`[decoder]`, `[simulator]`, `[ws]`). One line per meaningful event, no noisy per-batch spam (gate behind a counter, e.g. every 50 batches).
- Frontend: a small "metrics strip" should always show `latency_ms`, `accuracy`, `session_accuracy`, and connection state.
- When something is slow or wrong, the user should know **without opening DevTools**.

---

## 4. Testing Standards

- **Add or update tests for any change to `app/decoder.py`, `app/simulator.py`, or `app/main.py`.**
- `pytest` is the only test runner that CI cares about; manual WebSocket scripts (`tests/test_client.py`, `tests/test_decoder_client.py`) are excluded via `tests/conftest.py` and must stay that way.
- Coverage is tracked (`pytest-cov`). Don't lower it without justification.
- Frontend regressions are caught by `tsc` + `eslint` + `vite build`. If you add complex UI logic (cursor physics, raster windowing), extract pure functions and unit-test them.

---

## 5. Git Workflow & Commit Conventions

### Branching

- `main` is always deployable. CI runs on every push and PR.
- Feature work happens on short-lived branches: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`, `perf/<slug>`, `refactor/<slug>`.
- Rebase on `main` before opening a PR. No merge commits inside feature branches.

### Commit Messages (Conventional Commits)

Format:

```
<type>(<scope>): <imperative summary, ≤72 chars>

<optional body: what & why, not how>

<optional footer: refs, breaking changes>
```

**Allowed types:** `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`, `ci`, `build`.

**Allowed scopes:** `decoder`, `simulator`, `api`, `ws`, `frontend`, `dashboard`, `infra`, `ci`, `docs`, `tests`.

Examples:

```
feat(decoder): add 200ms sliding window with overlap-50%
perf(ws): pre-allocate NumPy buffers, cut p50 latency 18ms → 6ms
fix(frontend): close WebSocket on unmount to stop ghost packets
docs(architecture): document Redis fan-out plan for closed-loop
```

### Pull Requests

- One logical change per PR. If you find yourself writing "and also…" in the description, split it.
- PR description must include: **what**, **why**, **how to verify**, and (for hot-path changes) **before/after numbers**.
- All checks green before merge. No "we'll fix CI later".
- Squash-merge to `main` with a clean Conventional Commit subject.

---

## 6. Hard Rules (Things to Never Do)

- ❌ Never change the `DecoderPacket` shape without updating: backend type, frontend type, tests, and `bci-architecture.md`.
- ❌ Never block the event loop (`time.sleep`, sync HTTP, sync file I/O in `async def`).
- ❌ Never log secrets, tokens, or full request bodies.
- ❌ Never commit `venv/`, `node_modules/`, `dist/`, `.coverage`, or local `.env` files.
- ❌ Never disable CI checks to merge faster.
- ❌ Never introduce a new top-level dependency without listing it in `requirements.txt` / `package.json` with a pinned version.

---

## 7. Encouragement (Mindset)

You are working on a Neuralink-style real-time system. Optimize for:

1. **Latency** — every millisecond shows up on a chart.
2. **Reliability** — the dashboard should run for hours without leaks or stalls.
3. **Clarity** — code a teammate can read in one pass; metrics a reviewer can trust at a glance.
4. **Polish** — tight UI, sensible defaults, excellent first-run experience.

When in doubt, choose the simpler, faster, more observable option.
