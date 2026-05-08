# Current Project Tree (Key Files)

> Keep this file accurate. If you add, move, or remove a tracked file at the
> top two levels, update this tree in the same PR.

```
neuralink-bci-sim/
├── .cursor/
│   └── rules/
│       ├── README.md                 # how to use these rules + example prompts
│       ├── project.md                # goals, stack, standards, git workflow
│       ├── bci-architecture.md       # data flow, latency budgets, contracts
│       ├── agents.md                 # 5 specialized agent personas
│       └── project-tree.md           # this file
├── .github/
│   └── workflows/
│       └── ci-cd.yml                 # pytest + coverage; FE lint/build; GHCR images on main
├── app/
│   ├── __init__.py
│   ├── main.py                       # FastAPI: /ws/bci-stream, /ws/decoder, /simulator/config, CORS
│   ├── simulator.py                  # NeuralSignalGenerator (LFP + spikes), shared `generator`
│   ├── decoder.py                    # BciDecoder, DecoderPacket, bootstrap training helpers
│   └── offline_eval.py               # offline metrics harness (no WebSocket)
├── tests/
│   ├── __init__.py
│   ├── conftest.py                   # excludes manual WebSocket scripts from pytest collection
│   ├── test_offline_eval.py          # pytest: decoder / confusion / accuracy
│   ├── test_client.py                # manual smoke: /ws/bci-stream (run as script)
│   └── test_decoder_client.py        # manual smoke: /ws/decoder (run as script)
├── frontend/
│   ├── Dockerfile                    # multi-stage: vite build → nginx static
│   ├── nginx.conf
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tsconfig.app.json
│   ├── tsconfig.node.json
│   ├── eslint.config.js
│   ├── postcss.config.js
│   ├── tailwind.config.js
│   ├── package.json
│   ├── package-lock.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                   # dashboard layout, WS, manual/auto modes
│       ├── App.css
│       ├── index.css                 # Tailwind entry + globals
│       ├── NeuralSignalCharts.tsx    # spike raster + mean firing rate
│       ├── cursorPhysics.ts          # manual cursor integration / intents
│       ├── vite-env.d.ts
│       └── assets/
├── Dockerfile                        # production backend image (uvicorn, multi-worker)
├── docker-compose.yml                # backend + frontend (+ optional Redis stub, commented)
├── requirements.txt
├── README.md                         # top-level user-facing README
├── .dockerignore
└── .gitignore
```

## Notes

- Python package root is `app/` at the repo root. There is **no separate `backend/` folder**.
- `app/decoder.py` and `app/simulator.py` are single modules — there are **no `decoder/` or
  `simulator/` subpackages**.
- `DecoderPacket` and other API types live in the backend (`app/decoder.py`); the frontend
  uses inline TypeScript types in `App.tsx` (no `frontend/src/types/decoder.ts`).
- Redis is referenced as a **commented stub** inside `docker-compose.yml` for future use; it
  is not yet wired into the runtime path.
- `venv/`, `node_modules/`, `dist/`, `.coverage`, and `.pytest_cache/` are gitignored and
  intentionally omitted from this tree.
