# Neuralink BCI dashboard (frontend)

React + TypeScript + Vite + Tailwind SPA for the **neuralink-bci-sim** backend: continuous handwriting on a square canvas, decoder metrics, neural spike raster, and thought-to-text output.

## Scripts

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies (Node 20+) |
| `npm run dev` | Dev server at [http://127.0.0.1:5173](http://127.0.0.1:5173) |
| `npm run build` | Production bundle → `dist/` |
| `npm run lint` | ESLint |
| `npm run preview` | Serve `dist/` locally |

## Backend URL

- **Development:** defaults to `http://localhost:8000` when `VITE_BACKEND_URL` is unset (`App.tsx`). Override in `frontend/.env`:

  ```env
  VITE_BACKEND_URL=http://localhost:8000
  ```

- **Production runtime (Docker/Railway):** set `VITE_BACKEND_URL` as a service variable so `config.js` points the SPA to the backend URL at container start.

Start the API before the UI: `uvicorn app.core.main:app --port 8000` from the repo root.

## UI overview

- **Center:** 1:1 handwriting canvas — Clear canvas, Recognize
- **Left:** Decoder metrics + compact neural signal charts
- **Right:** Current Letter + Full Text (accumulated sentence), Clear Text

Recognition is demo-local until the backend recognizer endpoint is wired; **Recognize** still drives the two-panel text flow.

## Docker

Built from this directory:

```bash
docker build --build-arg VITE_BACKEND_URL=https://api.example.com -t bci-frontend .
```

Served on port **80** via nginx (`nginx.conf`).

See the root [README.md](../README.md) for full-stack `docker compose` and Railway deployment.
