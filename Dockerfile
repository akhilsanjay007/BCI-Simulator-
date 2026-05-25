# syntax=docker/dockerfile:1
# Multi-stage build: compile wheels with build tools, ship a slim runtime (no compiler chain).
FROM python:3.11-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        gcc \
        g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY requirements.txt .

# Pre-build wheels so the runtime stage only installs binary wheels (faster, smaller layer churn).
RUN pip install --no-cache-dir --upgrade pip \
    && pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt

# -----------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

# Non-root user: reduces blast radius if the process or deps are compromised.
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --home /app --shell /usr/sbin/nologin app

WORKDIR /app

ENV PYTHONPATH=/app \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

COPY requirements.txt .
COPY --from=builder /wheels /wheels

RUN pip install --no-cache-dir --no-index --find-links=/wheels -r requirements.txt \
    && rm -rf /wheels

# Weights are not baked in (see .dockerignore). Mount models/ or set MODEL_PATH at runtime.
RUN mkdir -p /app/models \
    && chown -R app:app /app/models

COPY app/ ./app/
# Shipped demo replays (override at runtime with a volume on /app/recordings).
COPY recordings/ ./recordings/
RUN chown -R app:app /app/recordings

USER app

EXPOSE 8000

# Run a single process in container runtimes (e.g. Railway). The decoder model
# is loaded in-process, so multi-worker mode multiplies memory usage and can
# trigger worker restart loops on small instances. Reload stays disabled because
# we do not pass --reload in production startup commands.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
