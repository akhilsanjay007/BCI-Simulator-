# Using `.cursor/rules` (IDE + Cloud agents)

This directory steers Cursor toward a **senior Neuralink-style** bar: real-time discipline, bounded buffers, observable latency, and shipping-quality diffs.

## File format (required for detection)

Cursor **only auto-loads** rules from **`.mdc`** files with YAML frontmatter:

```yaml
---
description: Brief summary shown in the rule picker
alwaysApply: true   # or false
globs: **/*.py     # optional — apply when matching files are open
---
```

Plain **`.md`** files in this folder are **not** picked up by Cursor. Use `.mdc` for rules; keep this `README.md` as human documentation only.

---

## What each rule file does

| File | Role |
| --- | --- |
| `project.mdc` | Goal, stack, quality bar, hard rules |
| `bci-architecture.mdc` | Pipeline, modes, contracts, latency table |
| `agents.mdc` | Five personas (`@CoreEngineer`, …) |
| `project-tree.mdc` | Layout truth for quick navigation |
| `README.md` | How to use rules (this file) |

---

## Cursor IDE (local)

Rules in `.cursor/rules/*.mdc` are **project context**. They inform completions and agent turns automatically when `alwaysApply: true` or when matching `globs` files are open.

**Verify rules are active**

1. Open **Cursor Settings → Rules** (or the rule picker in chat).
2. Confirm the four `.mdc` rules appear with their descriptions.

**Get better answers**

1. Tag an agent: `@Frontend …`, `@CoreEngineer …` (see `agents.mdc`).
2. State **success criteria** (numbers, files, behavior) and **what must not regress** (contracts, latency).
3. Ask for **verification steps** (`pytest`, `npm run build`, manual WS check).

---

## Cursor Cloud agents

Cloud agents clone the repo and run in a remote environment. Treat rules as the **default spec**:

- Put **non-negotiables** in `project.mdc` / `bci-architecture.mdc` (contracts, async rules, buffer caps).
- In the Cloud task description, repeat only what is **task-specific** (e.g. "touch only `BCITrackpad.tsx` and `cursorPhysics.ts`").
- Mention `@AgentName` in the Cloud prompt the same way as locally so the right checklist applies.
- If the Cloud agent adds files at the top level or under `app/` / `frontend/src/`, require an update to **`project-tree.mdc`** in the same change.

---

## Example prompt patterns

**Architecture**

> `@Architect` Summarize how Redis `bci:signals` relates to the live `/ws/decoder` loop today vs a consumer-group future. Update `bci-architecture.mdc` if you change the narrative.

**Backend**

> `@CoreEngineer` Reduce allocations in `BciDecoder.predict` without changing `DecoderPacket`. Include pytest + before/after p50/p95 `latency_ms`.

**Frontend / trackpad**

> `@Frontend` Refine `BCITrackpad` drawing: smoother ink, DPR-safe line width, no extra React parents re-rendering on each packet.

**CI**

> `@DevOps` Ensure CI installs Redis service for any test that needs it, or keep redis tests mock-only — document which.

---

## When Cursor pushes back

Rules instruct agents to refuse unsafe patterns (blocking event loop, silent contract breaks). Prefer the suggested alternative or explicitly override with a justified exception.
