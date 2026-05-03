# BCI Real-time Simulator + Decoder Dashboard

## Project Status
- Phase 1–3 completed: Simulator + ML Decoder + FastAPI WebSocket + React Dashboard (live streaming working)
- Currently entering Phase 4

## Goals
- Keep pushing real-time performance, evaluation rigor, and polish
- Maintain clean, typed, production-grade code
- Make the project stand out for Neuralink (low latency, strong metrics, excellent UX)

## Tech Stack (Do Not Change)
- Backend: Python + FastAPI + WebSockets
- Frontend: React + TypeScript + Tailwind
- ML: scikit-learn (PyTorch allowed for upgrades)
- Docker for deployment

## Rules for All Changes
- Respect existing folder structure and naming conventions
- Keep WebSocket contract (DecoderPacket) unchanged unless we explicitly decide to evolve it
- Always add/update tests when modifying core logic
- Use black/ruff/mypy on Python, strict TypeScript on frontend
- Measure and show latency/throughput
- Write clear commit messages