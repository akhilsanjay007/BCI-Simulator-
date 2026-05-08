# Using the Cursor Rules in This Project

This folder configures how Cursor reasons about the **neuralink-bci-sim** codebase.
The goal is to make Cursor behave like a **senior Neuralink engineer**: high standards,
practical, latency-obsessed, encouraging.

---

## What's in here

| File                  | Purpose                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `project.md`          | Project goal, tech stack, coding standards, git workflow, hard rules    |
| `bci-architecture.md` | Data flow, WebSocket contracts, latency budgets, buffering, future work |
| `agents.md`           | 5 specialized agent personas with rules and "never do" lists            |
| `project-tree.md`     | Accurate snapshot of the repo layout (top two levels)                   |
| `README.md`           | This file — how to actually use the rules                               |

These files are loaded by Cursor automatically. **You don't need to attach them manually**;
just write a clear prompt.

---

## How to get the most out of them

### 1. Pick an agent persona

Prefix the prompt with the agent in brackets. This focuses Cursor on the right
responsibilities and "never do" list.

```
[Architect Agent]   → design decisions, contracts, RFC-style work
[Core Engineer Agent] → backend Python, decoder, simulator, hot path
[Frontend Agent]    → React/TS dashboard work
[Testing & Quality Agent] → tests, lint, coverage, regression hunts
[DevOps & Deployment Agent] → Docker, GitHub Actions, GHCR, env config
```

You can stack roles when needed: `[Architect Agent + Core Engineer Agent]`.

### 2. Be specific about success criteria

Cursor performs best when you state the **target** (numbers, files, behavior) and the
**guardrails** (what not to break). The rules already encode the guardrails — you supply
the target.

Good prompt:

> [Core Engineer Agent] In `app/decoder.py`, replace the per-channel Python loop in
> `_extract_features` with a vectorized NumPy op. Keep `DecoderPacket` and the test
> suite green. Report p50/p95 `latency_ms` from a 30 s `/ws/decoder` run before and
> after the change.

Less good:

> Make the decoder faster.

### 3. Demand observability

Any change to the hot path should come back with **measured numbers**, not vibes.
The rules tell Cursor to do this; reinforce it in your prompt when it matters.

### 4. Keep the tree honest

If a change adds, moves, or removes a tracked file at the top two levels, Cursor should
update `project-tree.md` in the same response. If it forgets, ask.

---

## Example prompts for common tasks

### Architecture & contracts

```
[Architect Agent] Sketch a Redis Streams migration for /ws/decoder fan-out.
Cover: stream names, consumer groups, backpressure, rollback. Update
bci-architecture.md (current vs planned section).
```

### Backend perf / decoder

```
[Core Engineer Agent] Profile BciDecoder.predict on a 60 s synthetic run.
Identify the top 3 hotspots. Implement the fix for #1 only, with tests.
Report before/after p50 and p95 latency_ms.
```

### Backend feature

```
[Core Engineer Agent] Add a /decoder/stats GET endpoint that returns the last
60 s of latency_ms (p50, p95, p99) and accuracy. Pydantic response model,
unit tests, no change to DecoderPacket.
```

### Frontend UI

```
[Frontend Agent] Add a 60-sample latency_ms sparkline to the metrics strip
in App.tsx. Throttle to 30 Hz, ring-buffer in useRef, no per-packet React
re-render. Tailwind only.
```

### Frontend reliability

```
[Frontend Agent] Audit the WebSocket lifecycle in App.tsx. Confirm cleanup
on unmount, exponential backoff (cap 2 s) on reconnect, and no ghost packets
when the tab regains focus. Add a small "connection state" pill.
```

### Tests

```
[Testing & Quality Agent] Add coverage for POST /decoder/reset: assert
buffers, cursor, rolling accuracy, and session_accuracy are cleared.
Use pytest + httpx. No flaky timing.
```

### CI / Docker

```
[DevOps & Deployment Agent] Cut the backend GHCR image build time. Move
requirements.txt install above the COPY of app/ to maximize layer caching.
Verify locally with docker build --progress=plain.
```

### Cross-cutting

```
[Architect Agent + Core Engineer Agent + Frontend Agent] Add a num_channels
selector (32 / 64 / 128) to /simulator/config. Backend regenerates the
generator singleton on change; frontend resizes the raster live. Tests for
the API; no DecoderPacket change. Update bci-architecture.md if needed.
```

---

## When Cursor pushes back, listen

If a request would violate `project.md` or `bci-architecture.md` (e.g., changing the
`DecoderPacket` shape without coordinated updates, or blocking the event loop), the rules
instruct Cursor to **push back briefly and propose the compliant alternative**. That's the
intended behavior — accept the alternative or explicitly waive the rule with a reason.

---

## Updating the rules themselves

- These files live in `.cursor/rules/` and are tracked in git.
- Treat changes to them as you would any other code change: a focused PR, a clear commit
  message (`docs(rules): …`), and a one-line summary of *what behavior changes* for Cursor.
- If you add a new rule file, list it in the table at the top of this README.
