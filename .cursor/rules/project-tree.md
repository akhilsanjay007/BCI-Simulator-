# Project tree (key paths)

> Update in the same PR when you add or relocate **tracked** top-level or `app/` / `frontend/src/` entry points.

```
neuralink-bci-sim/
├── .cursor/
│   └── rules/
│       ├── README.md
│       ├── project.md
│       ├── bci-architecture.md
│       ├── agents.md
│       └── project-tree.md
├── .github/
│   └── workflows/
│       └── ci-cd.yml
├── app/
│   ├── __init__.py
│   ├── main.py                 # FastAPI, CORS, WS, health, decoder/simulator routes
│   ├── simulator.py            # NeuralSignalGenerator + optional Redis publish
│   ├── decoder.py              # BciDecoder, DecoderPacket, training / artifact load
│   ├── redis_client.py         # Async Redis Streams buffer (REDIS_URL)
│   └── offline_eval.py         # Offline metrics (no WebSocket)
├── models/
│   ├── .gitkeep
│   └── velocity_decoder.pkl    # Default shipped weights (MODEL_PATH / DECODER_MODEL_PATH)
├── tests/
│   ├── __init__.py
│   ├── conftest.py
│   ├── test_offline_eval.py
│   ├── test_redis_client.py
│   ├── test_client.py          # manual WS smoke (not collected by pytest)
│   └── test_decoder_client.py  # manual WS smoke (not collected by pytest)
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── index.html
│   ├── vite.config.ts
│   ├── package.json
│   ├── eslint.config.js
│   ├── postcss.config.js
│   ├── tailwind.config.cjs
│   ├── tailwind.config.js
│   ├── tsconfig*.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx             # layout, WS, manual/automatic, metrics strip
│       ├── App.css
│       ├── index.css
│       ├── BCITrackpad.tsx     # canvas: cursor + handwriting ink + mode chrome
│       ├── NeuralSignalCharts.tsx
│       ├── cursorPhysics.ts
│       └── vite-env.d.ts
├── Dockerfile
├── docker-compose.yml          # backend + frontend + redis (REDIS_URL wired for backend)
├── requirements.txt
├── railway.toml
├── README.md
├── .dockerignore
└── .gitignore
```

**Notes**

- Python package root is `app/` at repo root (no separate `backend/`).
- `DecoderPacket` types are defined in backend Pydantic models; frontend duplicates the shape inline in `App.tsx` — keep them identical.
- `venv/`, `node_modules/`, `dist/`, `.coverage`, `.pytest_cache/` are intentionally omitted.
