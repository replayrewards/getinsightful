# Architecture

GetInsightful is one desktop app with four moving parts:

```
┌─────────────────────────────────────────────────────────────┐
│ Tauri 2 desktop shell                                       │
│                                                             │
│  React 19 UI (src/)          axum API (src-tauri/src/)      │
│  dashboards, chat,           /api/*  +  /mcp                │
│  catalog, context            sqlx → warehouse Postgres      │
│         │                          │                        │
│         └──────────── ▲────────────┘                        │
│                       │ spawns                              │
│              Python runner (runner/)                        │
│              ingest.py  → PyAirbyte connector               │
│              context.py → context indexer                   │
└─────────────────────────────────────────────────────────────┘
                              │
                 docker-compose.yml (root)
                 one Postgres, two databases:
                   demo_src   — sample source system
                   warehouse  — GetInsightful's warehouse
```

## Components

| Part | Where | What it is |
|---|---|---|
| UI | `src/` | React 19 + Vite + Tailwind 4. Dashboards (grid layout + charts), chat, connector catalog, warehouse browser, context/memory review. |
| Desktop shell + API | `src-tauri/` | Tauri 2 app embedding an [axum](https://github.com/tokio-rs/axum) server on `:3000`. All state lives in the warehouse Postgres via [sqlx](https://github.com/launchbadge/sqlx). |
| Runner | `runner/` | Small Python layer. `ingest.py` runs a **real** Airbyte connector via [PyAirbyte](https://github.com/airbytehq/PyAirbyte) and lands typed tables in the warehouse; `context.py` indexes warehouse tables into the context store; `registry.json` is the connector catalog. |
| Demo backend | `docker-compose.yml` + `tests/` | One Postgres on `:5437` with the `demo_src` source DB and the `warehouse`. Seeded by `tests/seed/001_demo.sql` (deterministic, ~90 days of engineering data). |

## Data flow

1. **Connect** — pick a source from the 600+ Airbyte OSS connector registry,
   fill in its own spec fields (fetched live via `/api/connectors/{id}/spec`).
2. **Ingest** — a sync spawns `runner/ingest.py`, which runs the actual
   PyAirbyte connector. Nothing is mocked: credentials go to the real
   connector, typed tables land in the warehouse.
3. **Context index** — `runner/context.py` walks the warehouse and builds the
   context store: entities, tables, domain knowledge, dashboards.
4. **Ask** — chat turns plain-English questions into **read-only SQL**,
   grounded in the context store, and renders answers as charts/tables with
   the SQL shown ("answers come with receipts").
5. **Remember** — chat can propose learnings (memories); nothing sticks
   without your approval in the review UI. Approved memories are grounded into
   future answers and are searchable via `/api/context/search`.

## MCP server

The API exposes an MCP endpoint at `http://localhost:3000/mcp` (JSON-RPC
over HTTP) so agents like Claude Desktop or Cursor can search the context
store (`context_search`) against your warehouse. Point any MCP client at it —
no extra process required.

## API surface

26 routes under `/api/*` plus `/mcp` — connectors CRUD + sync, warehouse
table browse/preview, sync history, dashboards CRUD, query + raw SQL,
context overview/search/memories, chat + sessions + config. Start reading at
`src-tauri/src/lib.rs` for the route table.

## Where to plug in

- **Dashboards programmatically** — [docs/AGENT_GUIDE.md](AGENT_GUIDE.md) is
  the JSON contract for creating/editing dashboards via the API.
- **New connectors** — nothing to write; the catalog comes from the Airbyte
  registry (`runner/registry.json`).
- **AI provider** — chat provider is configurable at runtime
  (`/api/chat/config`); the memory-core e2e (`tests/e2e_memory.sh`) runs
  against a mock Anthropic-protocol provider with no API key.
- **Warehouse** — any Postgres URL via `DATABASE_URL` (default
  `postgres://insightful:insightful@localhost:5437/warehouse`).
