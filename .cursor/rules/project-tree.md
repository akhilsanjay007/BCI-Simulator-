# Current Project Tree (Key Files)

```
neuralink-bci-sim/
├── .cursor/
│   └── rules/
│       ├── agents.md
│       ├── bci-architecture.md
│       ├── project.md
│       └── project-tree.md          # this file
├── app/
│   ├── __init__.py
│   ├── main.py                      # FastAPI: /ws/bci-stream, /ws/decoder, /simulator/config, CORS, …
│   ├── simulator.py                 # NeuralSignalGenerator (spikes + LFP), shared `generator`
│   ├── decoder.py                   # BciDecoder, DecoderPacket, bootstrap training helpers
│   └── offline_eval.py              # offline metrics (no WebSocket)
├── tests/
│   ├── conftest.py                  # excludes manual WebSocket scripts from pytest
│   ├── test_offline_eval.py         # pytest: decoder / confusion / accuracy
│   ├── test_client.py               # manual smoke: /ws/bci-stream (run as script)
│   └── test_decoder_client.py       # manual smoke: /ws/decoder (run as script)
├── frontend/
│   ├── index.html
│   ├── vite.config.ts
│   ├── postcss.config.js
│   ├── tailwind.config.js           # also tailwind.config.cjs if present
│   ├── package.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                  # dashboard layout, WS, manual/automatic modes
│       ├── NeuralSignalCharts.tsx   # spike raster + mean firing rate (channel count from backend)
│       ├── cursorPhysics.ts         # manual cursor integration / intents
│       ├── index.css                # Tailwind entry + global styles
│       └── assets/
├── requirements.txt
├── README.md
└── .gitignore
```

Notes:

- No separate `backend/` folder: Python package root is `app/` at the repo root.
- No `decoder/` or `simulator/` subpackages under `app/` — they are single modules `decoder.py` and `simulator.py`.
- `DecoderPacket` / API types live in the backend (`app/decoder.py`); the frontend uses inline TypeScript types in `App.tsx` (not `frontend/src/types/decoder.ts`).
