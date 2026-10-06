# tests/ — local demo backend

Everything the sample-data path needs lives here: a single small Postgres with
two databases and the deterministic Genzeon seed.

- `docker-compose.yml` — postgres:16-alpine on **localhost:5437**
  - `genzeon_src` — the "company" source system (seeded by the wizard)
  - `warehouse`   — GetInsightful's local warehouse (the Airbyte cache target)
- `seed/001_genzeon.sql` — ~90 days of engineering data: services, incidents,
  deployments, metric_samples (Prometheus-style), db_health, alerts. Re-runnable.
- `init/01-warehouse.sql` — creates the `warehouse` DB on first container init.

## Manual run (the setup wizard automates exactly this)

```sh
docker compose -f tests/docker-compose.yml up -d --wait
docker compose -f tests/docker-compose.yml exec -T db \
  psql -U insightful -d genzeon_src -v ON_ERROR_STOP=1 -f /seed/001_genzeon.sql

# one-time: python runner venv (real Airbyte connectors via PyAirbyte)
uv venv runner/.venv && uv pip install --python runner/.venv/bin/python -r runner/requirements.txt

# then click "Start with sample data" in the app, or:
runner/.venv/bin/python runner/ingest.py source-postgres \
  '{"host":"localhost","port":5437,"database":"genzeon_src","username":"insightful","password":"insightful","replication_method":{"method":"Standard"}}' \
  --cache-url postgres://insightful:insightful@localhost:5437/warehouse
runner/.venv/bin/python runner/context.py
```

Connection string used by the API: `postgres://insightful:insightful@localhost:5437/warehouse`
(override with `DATABASE_URL`).
