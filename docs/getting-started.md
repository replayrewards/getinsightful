# Getting started

GetInsightful is a local-first desktop app: everything runs on your machine —
the UI, the API, the warehouse, and the pipelines.

## Prerequisites

| Tool | Why | Check |
|---|---|---|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | runs the local Postgres (demo source + warehouse) | `docker info` |
| [Rust](https://rustup.rs/) | compiles the Tauri shell + embedded API | `cargo --version` |
| Node.js 18+ | builds the React UI | `node --version` |
| [uv](https://docs.astral.sh/uv/) | one-time: Python venv for the PyAirbyte runner | `uv --version` |

## Quickstart

```sh
git clone https://github.com/sksum/getinsightful
cd getinsightful
./run.sh
```

`./run.sh`:

1. Stops anything already on `:3000` / `:1420`
2. Starts the local Postgres (`docker compose up -d --wait`)
3. Installs node deps if missing, then launches `npm run tauri dev`
   (first compile takes a few minutes)
4. Waits for the embedded API, and — if the warehouse is empty — runs the
   demo pipeline through the app's own setup endpoint, streaming each step
   into the terminal

When the desktop window opens you're done. Second runs skip the ingest if
demo data is already present.

`./run.sh --fresh` wipes the docker volume first and re-ingests from scratch.

## First-run wizard

On first launch the app offers two paths:

- **Start with sample data** — boots the demo Postgres, seeds ~90 days of
  engineering data, registers a real `source-postgres` connector, runs a real
  Airbyte ingest into the warehouse, builds the context store, and creates a
  default dashboard. Requires Docker; ~2 min the first time (the connector
  downloads once).
- **Connect your own data** — sends you to **Data → Connector catalog** to
  pick from 600+ Airbyte OSS connectors and sync into the same local
  warehouse.

## Ports

| Port | Service |
|---|---|
| `1420` | Vite dev server (the UI — also rendered in the desktop window) |
| `3000` | Embedded axum API (`/api/*`, `/mcp`) |
| `5437` | Demo Postgres (host mapping of container `5432`) |

## Connect to the warehouse

Anything that speaks Postgres can query the warehouse directly:

```
postgres://insightful:insightful@localhost:5437/warehouse
```

The API uses the same URL; override it with `DATABASE_URL`.

## Manual pipeline (what the wizard automates)

```sh
docker compose up -d --wait
docker compose exec -T db \
  psql -U insightful -d demo_src -v ON_ERROR_STOP=1 -f /seed/001_demo.sql

# one-time python runner venv
uv venv runner/.venv && uv pip install --python runner/.venv/bin/python -r runner/requirements.txt

# real Airbyte ingest → warehouse, then context index
runner/.venv/bin/python runner/ingest.py source-postgres \
  '{"host":"localhost","port":5437,"database":"demo_src","username":"insightful","password":"insightful","replication_method":{"method":"Standard"}}' \
  --cache-url postgres://insightful:insightful@localhost:5437/warehouse
runner/.venv/bin/python runner/context.py
```

More on the demo backend in [tests/README.md](../tests/README.md).

## Stopping

`Ctrl-C` in the `run.sh` terminal stops the app and shuts down the API. The
Postgres container keeps running (your data persists in the docker volume) —
`docker compose down -v` removes it.
