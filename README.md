<div align="center">

<img src="public/logo.svg" alt="GetInsightful" width="56">

# GetInsightful

**A brain for your warehouse.**

The AI-native, local-first data workspace: real Airbyte connectors into a
local warehouse, a context layer over everything, and plain-English questions
answered with charts, SQL, and receipts.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![GitHub stars](https://img.shields.io/github/stars/sksum/getinsightful?style=flat&logo=github)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![Built with](https://img.shields.io/badge/built%20with-Tauri%202%20%7C%20React%2019%20%7C%20PyAirbyte-e8603c)

[Website](https://replayrewards.github.io) •
[Getting started](docs/getting-started.md) •
[Architecture](docs/architecture.md) •
[Agent guide](docs/AGENT_GUIDE.md) •
[Issues](https://github.com/sksum/getinsightful/issues)

<img src="site/assets/dashboard.png" alt="GetInsightful dashboards" width="900">

</div>

## What is GetInsightful?

GetInsightful runs **real Airbyte connectors** (600+ OSS sources — Postgres,
Stripe, Snowflake, …) against your data sources and lands typed tables in a
local Postgres warehouse. It indexes everything into a **context layer** —
entities, tables, domain knowledge, and approved memories — and turns plain
questions into **read-only SQL, charts, and dashboards** any agent can use.

It's a desktop app (Tauri 2). Your data, your keys, your machine — nothing
leaves it except calls to the AI provider you configure.

## Why GetInsightful?

- **Real pipelines, no simulations** — ingests run genuine PyAirbyte
  connectors; the SQL behind every answer is shown next to it.
- **Local-first** — warehouse, context store, and API all live on your
  machine. `docker compose up` is the only infrastructure.
- **A context layer, not just a chat box** — entities, table docs, and
  memories are indexed once and grounded into every answer, for humans and
  agents alike.
- **Nothing sticks without your yes** — chat-proposed learnings wait in an
  approval queue with provenance before they're remembered.
- **Dashboards as data** — dashboards are JSON you can write by hand or let
  an agent write (see the [agent guide](docs/AGENT_GUIDE.md)).
- **MCP built in** — `http://localhost:3000/mcp` speaks MCP, so Claude
  Desktop or Cursor can search your context store directly.

## Get started

Prerequisites: [Docker Desktop](https://www.docker.com/products/docker-desktop/),
[Rust](https://rustup.rs/) (for the Tauri shell), Node.js 18+, and
[uv](https://docs.astral.sh/uv/) (one-time, for the Python runner).

```sh
git clone https://github.com/sksum/getinsightful
cd getinsightful
./run.sh
```

That starts the local Postgres, launches the desktop app, and — on first
run — streams the demo pipeline (seed → real Airbyte ingest → context index
→ default dashboard) into your terminal. Full walkthrough in
[docs/getting-started.md](docs/getting-started.md).

Prefer your own data over the demo tenant? Pick **Connect your own data** in
the first-run wizard and sync from any of the 600+ connectors in
**Data → Connector catalog**.

## Docker

One small Postgres does both jobs (`docker-compose.yml` at the repo root):

| Database | Role |
|---|---|
| `demo_src` | the sample "company" source system (seeded with ~90 days of engineering data) |
| `warehouse` | GetInsightful's local warehouse — where connector syncs land |

It listens on **localhost:5437** (`insightful` / `insightful`), mounts
`tests/seed/` at `/seed`, and stores data in the `demo_pg` volume.
`./run.sh --fresh` wipes the volume and re-ingests from scratch.

## What's inside this repository

| Path | What it is |
|---|---|
| `src/` | React 19 + Vite + Tailwind 4 UI — dashboards, chat, catalog, warehouse browser, context review |
| `src-tauri/` | Tauri 2 shell + embedded axum/sqlx API on `:3000` (`/api/*`, `/mcp`) |
| `runner/` | Python runner — `ingest.py` (PyAirbyte), `context.py` (context indexer), connector registry |
| `tests/` | demo seed + docker init, memory-core e2e (`e2e_memory.sh`, runs against a mock provider — no API key) |
| `site/` | the landing page served at [replayrewards.github.io](https://replayrewards.github.io) |
| `docs/` | [getting started](docs/getting-started.md), [architecture](docs/architecture.md), [agent guide](docs/AGENT_GUIDE.md) |

## Screenshots

| | |
|---|---|
| ![Chat](site/assets/chat.png) | ![Context](site/assets/context.png) |
| ![Warehouse](site/assets/warehouse.png) | ![Catalog](site/assets/catalog.png) |

## GetInsightful vs hosted BI

| | GetInsightful | Hosted BI / cloud warehouse |
|---|---|---|
| Where your data lives | your machine | someone else's cloud |
| Setup | `./run.sh` | sales call, then a migration |
| Ingestion | real Airbyte connectors, local | vendor-specific ELT |
| AI answers | grounded in your context layer, SQL shown | per-seat AI add-on |
| Agent access | built-in MCP endpoint | varies |
| Cost | open source, bring your own model key | per seat + per query |

## Roadmap

- Scheduled connector syncs (today: manual + setup-time syncs)
- More warehouse targets beyond local Postgres
- Packaged desktop builds for macOS / Windows / Linux

## Need help?

- Read the [docs](docs/getting-started.md) or the
  [FAQ on the website](https://replayrewards.github.io#faq)
- Browse the [agent guide](docs/AGENT_GUIDE.md) to build dashboards
  programmatically
- [Open an issue](https://github.com/sksum/getinsightful/issues)

## Contributing

PRs welcome — pick an issue or propose one. If you're an agent (or just
prefer JSON), the [agent guide](docs/AGENT_GUIDE.md) is the contract for
dashboards.

## License

[MIT](LICENSE) — free to use, modify, and ship.

---

Built for people who'd rather ask their warehouse a question than write a
ticket about it.
