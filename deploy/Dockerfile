# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────
# Flowboard agent image
#   • multi-stage: Node 20 builds the React/Vite frontend, Python 3.11
#     slim runs the FastAPI agent + WebSocket server.
#   • frontend/dist is baked in at /app/frontend/dist — main.py's
#     StaticFiles mount picks it up automatically.
#   • No LLM CLI is installed; the agent talks to MiniMax via HTTPS.
# ─────────────────────────────────────────────────────────────────────

# ── Stage 1: build frontend ──────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /build

# Cache npm install layer
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./
RUN npm run build && \
    test -f dist/index.html

# ── Stage 2: Python runtime ──────────────────────────────────────────
FROM python:3.11-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app/agent \
    FLOWBOARD_STORAGE=/srv/storage \
    FLOWBOARD_HTTP_PORT=8101 \
    FLOWBOARD_EXT_WS_PORT=9223 \
    FLOWBOARD_WS_HOST=127.0.0.1 \
    FLOWBOARD_SECRETS_PATH=/srv/secrets/secrets.json

WORKDIR /app

# System deps: curl for healthcheck, ca-certificates for outbound HTTPS
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Python deps (cached layer; only re-runs when requirements.txt changes)
COPY agent/requirements.txt /tmp/requirements.txt
RUN pip install --upgrade pip && \
    pip install -r /tmp/requirements.txt

# Agent source — PYTHONPATH=/app/agent lets `import flowboard` resolve
COPY agent/flowboard /app/agent/flowboard
COPY agent/pyproject.toml /app/agent/pyproject.toml

# Frontend dist consumed by main.py's StaticFiles mount
COPY --from=frontend-builder /build/dist /app/frontend/dist

# Persistent mount points (created here so volume mounts work on first run)
RUN mkdir -p /srv/storage /srv/secrets && \
    chown -R nobody:nogroup /srv /app

USER nobody

EXPOSE 8101 9223

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8101/api/health || exit 1

CMD ["python", "-m", "uvicorn", "flowboard.main:app", \
     "--host", "0.0.0.0", "--port", "8101", \
     "--log-level", "info"]
