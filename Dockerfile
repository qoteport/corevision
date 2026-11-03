# Core Vision: one image with the React frontend and the FastAPI backend.
# The SQLite database and uploaded photos live in /data — mount a persistent volume there.

# ---------- 1. build the frontend ----------
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- 2. runtime ----------
FROM python:3.13-slim AS app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    CV_DATA_DIR=/data \
    PORT=8000
WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY backend/ ./backend/
COPY --from=web /web/dist ./frontend/dist

# Run as an unprivileged user that owns the data directory.
RUN useradd --create-home --uid 10001 corevision \
    && mkdir -p /data \
    && chown -R corevision:corevision /data
USER corevision
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/api/health', timeout=4)"

# Migrations run automatically at startup. PORT is set by hosts like Railway, Render and Fly.io.
CMD ["sh", "-c", "exec uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
