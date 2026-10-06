-- Genzeon (demo tenant) engineering source data — deterministic, 90 days.
-- Applied inside the sample source DB (genzeon_src) by the setup wizard:
--   docker compose exec -T db psql -U insightful -d genzeon_src -f /seed/001_genzeon.sql
-- Re-runnable: drops and recreates its tables.

select setseed(0.42);

drop table if exists alerts cascade;
drop table if exists db_health cascade;
drop table if exists metric_samples cascade;
drop table if exists deployments cascade;
drop table if exists incidents cascade;
drop table if exists services cascade;

create table services (
  name text primary key,
  team text not null,
  tier int not null              -- 0 = most critical
);

insert into services (name, team, tier) values
  ('patient-api',      'platform',     0),
  ('identity-svc',     'platform',     0),
  ('hl7-interface',    'integrations', 1),
  ('ehr-sync',         'integrations', 1),
  ('lab-results-api',  'integrations', 1),
  ('claims-engine',    'claims',       1),
  ('scheduling-svc',   'product-apps', 1),
  ('billing-api',      'revenue',      2),
  ('portal-web',       'product-apps', 2),
  ('pharmacy-svc',     'claims',       2),
  ('provider-search',  'product-apps', 3),
  ('notifications',    'product-apps', 3);

create table incidents (
  id text primary key,
  service text not null,
  severity text not null,        -- sev1..sev4
  title text not null,
  opened_at timestamptz not null,
  resolved_at timestamptz,
  mttr_minutes real,
  status text not null           -- open | resolved
);
create index incidents_opened_idx on incidents (opened_at);
create index incidents_service_idx on incidents (service);

insert into incidents
select
  'INC-' || to_char(opened_at, 'YYYYMMDDHH24MI') || '-' || svc || '-' || rn,
  svc,
  sev,
  titles[1 + floor(r3 * array_length(titles, 1))::int],
  opened_at,
  case when open = 0 then opened_at + (mttr || ' minutes')::interval end,
  case when open = 0 then mttr end,
  case when open = 0 then 'resolved' else 'open' end
from (
  select
    svc, r3,
    (select array_agg(t) from unnest(ARRAY[
      'Elevated 5xx rate on primary endpoints',
      'Connection pool exhaustion under load',
      'Slow queries driving request timeouts',
      'Upstream dependency timeouts',
      'Disk usage crossed threshold',
      'Memory pressure / OOM kills in pods',
      'Replica lag beyond SLO',
      'Cache miss storm after config change',
      'Retry storm following failed deploy',
      'Message queue backlog growing',
      'Auth token validation failures spike',
      'Batch job overrunning its window'
    ]) as t) as titles,
    date_trunc('second', now()
      - (d || ' days')::interval
      - ((floor(r1 * 24)::int || ' hours')::interval)
      - ((floor(r2 * 3600)::int || ' seconds')::interval)) as opened_at,
    row_number() over () as rn
  from (
    select
      d.d,
      s.name as svc,
      (0.06 * s.tier + 1 + floor(random() * 3.2))::int as n_inc,
      random() as r1, random() as r2, random() as r3
    from generate_series(0, 89) as d(d)
    cross join services s
  ) base
  cross join lateral generate_series(1, base.n_inc) as i
) inc
cross join lateral (
  select
    case when inc.r3 < 0.07 then 'sev1' when inc.r3 < 0.22 then 'sev2'
         when inc.r3 < 0.5 then 'sev3' else 'sev4' end as sev,
    case
      when inc.r3 < 0.07 then 60 + random() * 180
      when inc.r3 < 0.22 then 40 + random() * 80
      when inc.r3 < 0.5  then 18 + random() * 42
      else 5 + random() * 25
    end as mttr,
    case when inc.opened_at < now() - interval '6 hours' and random() < 0.95 then 0 else 1 end as open
) sevcalc;

create table deployments (
  id text primary key,
  service text not null,
  env text not null,
  status text not null,          -- success | failed | rolled_back
  duration_s int not null,
  commit_sha text not null,
  started_at timestamptz not null
);
create index deployments_started_idx on deployments (started_at);

insert into deployments
select
  'DEP-' || to_char(started_at, 'YYYYMMDDHH24MI') || '-' || svc || '-' || rn,
  svc,
  case when r1 < 0.55 then 'production' when r1 < 0.85 then 'staging' else 'dev' end,
  case when r2 < 0.88 then 'success' when r2 < 0.96 then 'failed' else 'rolled_back' end,
  120 + floor(r3 * 1500)::int,
  substr(md5(r1::text || svc || started_at::text), 1, 7),
  started_at
from (
  select
    s.name as svc,
    date_trunc('hour', now()
      - (d || ' days')::interval
      - (floor(random() * 10)::int || ' hours')::interval
      - (floor(random() * 3600)::int || ' seconds')::interval) as started_at,
    random() as r1, random() as r2, random() as r3,
    row_number() over () as rn
  from generate_series(0, 89) as d(d)
  cross join services s
  cross join lateral generate_series(1, 1 + floor(random() * 2.6)::int) as i
) dep;

create table metric_samples (
  ts timestamptz not null,
  service text not null,
  metric text not null,          -- rps | p95_latency_ms | error_rate | cpu_pct | mem_pct
  value real not null,
  primary key (ts, service, metric)
);
create index metric_samples_ts_idx on metric_samples (ts);
create index metric_samples_metric_idx on metric_samples (metric, ts);

-- hourly samples, 90 days; diurnal sine + weekday falloff + noise
insert into metric_samples
select ts, svc, metric,
  case metric
    when 'rps' then greatest(0, base_rps * diurnal * weekday * (0.85 + noise * 0.3))
    when 'p95_latency_ms' then (80 + tier * 90 + noise * 220 + (1 - diurnal) * 60)::real
    when 'error_rate' then greatest(0.0002, 0.004 + tier * 0.002 + noise * 0.012)::real
    when 'cpu_pct' then least(99, 22 + tier * 6 + noise * 30)::real
    when 'mem_pct' then least(99, 35 + tier * 4 + noise * 25)::real
  end
from (
  select
    s.name as svc,
    s.tier,
    (120 - s.tier * 18)::real as base_rps,
    m.metric,
    ts.ts,
    (1 + 0.45 * sin(2 * pi() * (extract(hour from ts.ts) - 3) / 24))::real as diurnal,
    case when extract(dow from ts.ts) in (0, 6) then 0.45::real else 1::real end as weekday,
    random() as noise
  from services s
  cross join (values ('rps'), ('p95_latency_ms'), ('error_rate'), ('cpu_pct'), ('mem_pct')) as m(metric)
  cross join lateral (
    select date_trunc('hour', now()) - (h || ' hours')::interval as ts
    from generate_series(0, 90 * 24) as h
  ) ts
) gen;

create table db_health (
  ts timestamptz not null,
  database text not null,
  replica_lag_ms real not null,
  slow_queries int not null,
  conn_pool_pct real not null,
  disk_pct real not null,
  deadlocks int not null,
  primary key (ts, database)
);
create index db_health_ts_idx on db_health (ts);

insert into db_health
select
  date_trunc('hour', now()) - (h || ' hours')::interval,
  db,
  greatest(0, (40 + noise * 700 * (db like '%replica%')::int)::real),
  floor(noise * 18)::int,
  least(99, (30 + noise * 55)::real),
  least(99, (38 + h * 0.012 + noise * 8)::real),
  floor(noise * noise * 4)::int
from generate_series(0, 90 * 24) as h
cross join unnest(ARRAY[
  'pg-patients-primary', 'pg-patients-replica', 'pg-claims', 'pg-analytics', 'redis-sessions'
]) as db
cross join lateral (select random() as noise) n;

create table alerts (
  id text primary key,
  rule text not null,
  severity text not null,
  service text not null,
  fired_at timestamptz not null,
  resolved_at timestamptz,
  status text not null           -- firing | resolved
);
create index alerts_fired_idx on alerts (fired_at);

insert into alerts
select
  'ALR-' || to_char(fired_at, 'YYYYMMDDHH24MI') || '-' || svc || '-' || rn,
  rules[1 + floor(r2 * array_length(rules, 1))::int],
  case when r3 < 0.12 then 'critical' when r3 < 0.45 then 'warning' else 'info' end,
  svc,
  fired_at,
  case when firing = 0 then fired_at + (floor(r1 * 90)::int || ' minutes')::interval end,
  case when firing = 0 then 'resolved' else 'firing' end
from (
  select
    base.svc, base.r1, base.r2, base.r3,
    date_trunc('minute', now()
      - (d || ' days')::interval
      - (floor(base.r1 * 24)::int || ' hours')::interval) as fired_at,
    case when (d < 2 and random() < 0.25) then 1 else 0 end as firing,
    (select array_agg(t) from unnest(ARRAY[
      'HighErrorRate', 'LatencyP95Breach', 'DiskSpaceLow', 'ReplicaLagHigh',
      'ConnPoolSaturation', 'OOMKilled', 'DeploymentFailed', 'CertExpirySoon'
    ]) as t) as rules,
    row_number() over () as rn
  from (
    select d.d,
      (select name from services order by md5(name || d.d::text) limit 1) as svc,
      random() as r1, random() as r2, random() as r3
    from generate_series(0, 89) as d(d)
    cross join lateral generate_series(1, 1 + floor(random() * 5)::int) as i
  ) base
) al;
