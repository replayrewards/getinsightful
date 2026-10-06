# AGENT_GUIDE.md — building & editing dashboards programmatically

This document is the contract for AI agents (and humans who prefer JSON) to
create and edit GetInsightful dashboards. Everything an agent needs is here:
the dashboard JSON shape, the card catalog, SQL cards, variables, the API, and
the rules.

## Dashboard JSON

A dashboard is a row in the `dashboards` table. The editable part is `layout`:

```json
{
  "cards": [Card, Card, ...],
  "variables": [ {"name": "env", "type": "enum", "default": "prod", "options": ["prod","staging"]} ],
  "refresh_seconds": 0
}
```

`Card` — two flavors:

```json
{
  "id": "c1",              // unique within the dashboard, stable across edits
  "type": "kpi",           // kpi | hero | hbar | bar | line | table | insight
  "title": "Active incidents",
  "metric": "kpi_active_incidents",  // (a) built-in registry metric, or…
  "sql": "select … ",                // (b) custom SQL — wins over metric
  "x": 0, "y": 0, "w": 2, "h": 2,    // 12-column grid; y auto-compacts
  "options": { "unit": "ms", "goodDirection": "down" },
  "viz_options": {
    "unit": "ms",                    // value suffix
    "legend": true,                  // line charts
    "colors": { "billing-api": "#d95926" }  // per-series overrides
  }
}
```

### SQL cards

`sql` runs against the **local warehouse** (`airbyte_raw.*` tables landed by the
connectors) via `POST /api/query/sql`: read-only, single SELECT/WITH statement,
15s timeout, 5000-row cap. Variables are substituted server-side:

| variable | value |
|---|---|
| `{{freq}}` | `'hour' \| 'day' \| 'week'` — quoted literal, use as `date_trunc({{freq}}, ts)` |
| `{{range_start}}` / `{{range_end}}` | quoted RFC3339 timestamps from the date filter |
| `{{range}}` | `'24h' \| '7d' \| '30d' \| '90d'` |
| `{{services}}` | `'a','b'` or `''` |
| `{{services_filter}}` | ` and service in (…)` or empty — append after a WHERE clause |
| custom vars | from `layout.variables`, values escaped as literals |

Result shaping (`deriveViz`): **bar/hbar** = first text column is the label,
first numeric column the value; **line** = 3 columns `(label, name, value)` is
long format (pivoted per name), otherwise every numeric column is a series;
**kpi/hero** = first numeric cell; **table** = rows as-is.

Layout rules: grid is 12 columns; `w` 2–12, `h` 2–8 works well (row ≈ 46px + 12px gap).
KPI cards: `w:2 h:2`. Hero: `w:4 h:3`. Charts: `w:4 h:3–4`. Tables: `w:4–7 h:4`.

### options (built-in metric cards)

| key | types | meaning |
|---|---|---|
| `unit` | kpi | suffix rendered after the value (`ms`, `min`, `%`) |
| `goodDirection` | kpi | `"down"` if a negative delta is good (latency, errors), `"up"` otherwise |

## Metric catalog (what cards can query)

All metrics run against the **local warehouse only** and accept the global
filters (date range + service multi-select).

| metric | card type | shape returned |
|---|---|---|
| `kpi_active_incidents` | kpi | `{value, prev, delta_pct}` |
| `kpi_mttr` | kpi | avg resolution minutes |
| `kpi_deploys` | kpi | deploy count |
| `kpi_error_rate` | kpi | avg error_rate (0–1) |
| `kpi_p95_latency` | kpi | p95 of p95_latency_ms |
| `kpi_firing_alerts` | kpi | `{value}` |
| `hero_requests` | hero | `{value}` estimated requests |
| `incidents_by_service` | hbar | `{items: [{label, value}]}` |
| `deploys_per_day` | bar | `{items: [{label, value}]}` |
| `latency_by_service` | line | `{series: [{name, points: [{label, value}]}]}` |
| `db_replica_lag` | line | `{series: [...]}` |
| `recent_incidents` | table | `{columns, rows}` |
| `insight_main` | insight | `{text, basis}` |

New metrics: add a SQL arm to `query_metric` in `src-tauri/src/metrics.rs`,
then reference it from a card. Resolve tables with `find_table(db, "logical")`
— never hardcode cache table names.

## API

Base URL: `http://localhost:3000` (proxied as `/api` on the Vite dev server).

```sh
# list / create / update / delete
curl localhost:3000/api/dashboards
curl -X POST localhost:3000/api/dashboards -H 'content-type: application/json' \
  -d '{"name":"My Dashboard","layout":{"cards":[...]}}'
curl -X PUT localhost:3000/api/dashboards/<id> -H 'content-type: application/json' \
  -d '{"layout":{"cards":[...]}}'
curl -X DELETE localhost:3000/api/dashboards/<id>

# preview what a card will show
curl -X POST localhost:3000/api/query -H 'content-type: application/json' \
  -d '{"metric":"incidents_by_service","range":"7d","services":[]}'

# run a SQL card's query (same engine the editor uses)
curl -X POST localhost:3000/api/query/sql -H 'content-type: application/json' \
  -d '{"sql":"select service, count(*) n from \"airbyte_raw\".\"incidents\" where opened_at >= {{range_start}}::timestamptz group by 1 order by n desc","range":"7d","freq":"day","services":[]}'

# warehouse introspection (what tables exist to build metrics on)
curl localhost:3000/api/warehouse/tables
curl "localhost:3000/api/warehouse/tables/public/incidents?limit=5"
curl localhost:3000/api/context/overview
```

## Rules

1. **Read the warehouse before inventing cards.** `/api/warehouse/tables` +
   `/api/context/overview` tell you what data actually exists. If a metric has
   no backing table, don't ship the card.
2. **Prefer SQL cards.** A new question = a `sql` card, validated through
   `/api/query/sql`. Only add a Rust metric arm (`metrics.rs`) when the query
   needs the previous-period delta machinery or is reused across dashboards.
3. **Validate against `/api/query`** before writing the dashboard — every
   metric you reference must return 200.
4. **Color/type discipline**: one series → `bar`/`hbar`; multi-series → `line`;
   single headline → `kpi`/`hero`; ranked list → `hbar`; detail rows → `table`.
5. **One `insight` card per dashboard** — it's the narrative anchor.
6. `id` collisions break drag state: keep them unique per dashboard.
