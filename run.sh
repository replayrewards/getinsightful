#!/usr/bin/env bash
# GetInsightful launcher: kills old instances, starts the local Postgres, and
# runs the desktop app (vite :1420 + embedded API :3000). If the warehouse is
# empty, runs the demo pipeline (seed → real Airbyte ingest → context
# index → default dashboard) via the app's own setup endpoint.
#
#   ./run.sh          # restart, keep existing demo data
#   ./run.sh --fresh  # wipe the docker volume and re-ingest from scratch
set -euo pipefail
cd "$(dirname "$0")"

FRESH=0
[ "${1:-}" = "--fresh" ] && FRESH=1

kill_port() { lsof -ti ":$1" 2>/dev/null | xargs kill -9 2>/dev/null || true; }

echo "▸ stopping old instances (:3000 api, :1420 vite)"
kill_port 3000
kill_port 1420

if [ "$FRESH" = 1 ]; then
  echo "▸ --fresh: wiping docker volume (warehouse + source DB)"
  docker compose down -v
fi

echo "▸ starting Postgres"
docker compose up -d --wait

[ -d node_modules ] || { echo "▸ installing node deps"; npm ci; }

if [ ! -d runner/.venv ] && [ "$FRESH" = 1 ]; then
  echo "▸ creating runner venv (PyAirbyte — one-time)"
  command -v uv >/dev/null || { echo "uv not found — install it: https://docs.astral.sh/uv/"; exit 1; }
  uv venv runner/.venv
  uv pip install --python runner/.venv/bin/python -r runner/requirements.txt
fi

cleanup() { kill "${APP_PID:-0}" 2>/dev/null || true; }
trap cleanup EXIT INT

echo "▸ launching app (tauri dev — first compile takes a bit)"
npm run tauri dev &
APP_PID=$!

echo "▸ waiting for the embedded API on :3000"
for _ in $(seq 1 180); do
  curl -sf localhost:3000/api/status >/dev/null 2>&1 && break
  sleep 1
done
curl -sf localhost:3000/api/status >/dev/null || { echo "API never came up — see tauri output above"; exit 1; }

TABLES=$(curl -sf localhost:3000/api/status | python3 -c "import json,sys; print(json.load(sys.stdin)['warehouse_tables'])")
if [ "$TABLES" = "0" ] || [ "$FRESH" = 1 ]; then
  echo "▸ warehouse empty — running demo pipeline (real Airbyte ingest; first run downloads the connector)"
  curl -sf -N -X POST localhost:3000/api/setup/sample | while IFS= read -r line; do
    case $line in data:*) echo "  ${line#data: }" ;; esac
  done
else
  echo "▸ demo data already present ($TABLES warehouse tables) — skipping ingest"
fi

echo
echo "▸ GetInsightful running — desktop window should be open (or http://localhost:1420)"
echo "  stop: Ctrl-C here"
wait $APP_PID
