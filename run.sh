#!/usr/bin/env sh
# Core Vision: set up (first run only), build the frontend, start the server on http://localhost:8000
set -e
cd "$(dirname "$0")"
PY=.venv/bin/python; [ -x .venv/Scripts/python.exe ] && PY=.venv/Scripts/python.exe

if [ ! -x "$PY" ]; then
  echo "Creating Python environment..."
  python3 -m venv .venv 2>/dev/null || python -m venv .venv
  PY=.venv/bin/python; [ -x .venv/Scripts/python.exe ] && PY=.venv/Scripts/python.exe
  "$PY" -m pip install -q -r requirements.txt
fi
[ -f .env ] || cp .env.example .env
[ -d frontend/node_modules ] || npm --prefix frontend install --no-fund --no-audit
npm --prefix frontend run build

echo "Core Vision is running at http://localhost:8000 (Ctrl+C to stop)"
exec "$PY" -m uvicorn app.main:app --app-dir backend --port 8000
