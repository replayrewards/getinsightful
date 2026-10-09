// Starter SQL for built-in metrics, used to pre-fill the card editor. These
// are authoring templates ({{vars}} substituted server-side by /api/query/sql);
// once saved, the card is a plain SQL card — the Rust registry stays untouched.
// Tables live in schema `airbyte_raw` (PyAirbyte's PostgresCache).
//
// Style: variables WITHOUT surrounding quotes — the server emits proper SQL
// literals ('day', '2026-…'). Quoted forms ('{{freq}}') also work but are
// legacy.

export const BUILTIN_SQL: Record<string, string> = {
  kpi_active_incidents: `-- currently open incidents
select count(*)::double precision as value
from "airbyte_raw"."incidents"
where resolved_at is null{{services_filter}}`,

  kpi_mttr: `-- mean time to resolve, current window
select avg(mttr_minutes)::double precision as value
from "airbyte_raw"."incidents"
where resolved_at is not null
  and opened_at >= {{range_start}}::timestamptz{{services_filter}}`,

  kpi_deploys: `select count(*)::double precision as value
from "airbyte_raw"."deployments"
where started_at >= {{range_start}}::timestamptz{{services_filter}}`,

  kpi_error_rate: `select avg(value)::double precision as value
from "airbyte_raw"."metric_samples"
where metric = 'error_rate' and ts >= {{range_start}}::timestamptz{{services_filter}}`,

  kpi_p95_latency: `select percentile_cont(0.95) within group (order by value) as value
from "airbyte_raw"."metric_samples"
where metric = 'p95_latency_ms' and ts >= {{range_start}}::timestamptz{{services_filter}}`,

  kpi_firing_alerts: `select count(*)::double precision as value
from "airbyte_raw"."alerts"
where resolved_at is null`,

  hero_requests: `-- rps sampled hourly → requests ≈ sum(rps) * 3600
select (coalesce(sum(value), 0) * 3600)::double precision as value
from "airbyte_raw"."metric_samples"
where metric = 'rps' and ts >= {{range_start}}::timestamptz{{services_filter}}`,

  incidents_by_service: `select service as label, count(*)::int as value
from "airbyte_raw"."incidents"
where opened_at >= {{range_start}}::timestamptz{{services_filter}}
group by service
order by value asc`,

  deploys_per_day: `select date_trunc({{freq}}, started_at)::date::text as label,
       count(*)::int as value
from "airbyte_raw"."deployments"
where started_at >= {{range_start}}::timestamptz{{services_filter}}
group by 1
order by 1`,

  latency_by_service: `select date_trunc({{freq}}, ts)::date::text as label,
       service as name,
       percentile_cont(0.95) within group (order by value)::double precision as value
from "airbyte_raw"."metric_samples"
where metric = 'p95_latency_ms' and ts >= {{range_start}}::timestamptz{{services_filter}}
group by 1, 2
order by 1`,

  db_replica_lag: `select date_trunc({{freq}}, ts)::date::text as label,
       database as name,
       avg(replica_lag_ms)::double precision as value
from "airbyte_raw"."db_health"
where ts >= {{range_start}}::timestamptz
group by 1, 2
order by 1`,

  recent_incidents: `select id, service, severity, title,
       opened_at::text as opened_at,
       coalesce(mttr_minutes, 0)::double precision as mttr_minutes,
       status
from "airbyte_raw"."incidents"
where true{{services_filter}}
order by opened_at desc
limit 10`,

  insight_main: `select service,
       count(*) as incidents,
       count(*) filter (where severity in ('sev1','SEV1','critical')) as sev1
from "airbyte_raw"."incidents"
where opened_at >= now() - interval '7 days'{{services_filter}}
group by service
order by incidents desc
limit 5`,
};

// Starter for brand-new cards.
export const NEW_CARD_SQL = `-- {{freq}} = hour | day | week · {{range_start}}/{{range_end}} · {{services}} ('a','b')
select date_trunc({{freq}}, opened_at)::date::text as bucket,
       count(*)::int as incidents
from "airbyte_raw"."incidents"
where opened_at >= {{range_start}}::timestamptz
group by 1
order by 1`;
