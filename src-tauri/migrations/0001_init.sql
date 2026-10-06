-- GetInsightful local warehouse metadata. Sample/business data itself is landed
-- here by real Airbyte connector runs (PyAirbyte); these tables hold app state.

create extension if not exists pg_trgm;

create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  connector text not null,            -- Airbyte connector name, e.g. 'source-postgres'
  name text not null,
  category text not null default 'Custom',
  config jsonb not null default '{}', -- connector spec credentials
  status text not null default 'connected',
  schedule text not null default 'manual',
  last_sync_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists sync_logs (
  id bigserial primary key,
  source_id uuid references sources(id) on delete set null,
  connector text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running', -- running | done | failed
  streams jsonb not null default '{}',    -- { stream_name: rows_loaded }
  error text
);

create table if not exists dashboards (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  layout jsonb not null default '{"cards":[]}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Context store (Airbyte Agents-style pre-indexed business context, local flavor).
create table if not exists ctx_entities (
  id bigserial primary key,
  source text not null,
  collection text not null,
  entity_id text not null,
  title text not null,
  summary text not null default '',
  attrs jsonb not null default '{}',
  indexed_at timestamptz not null default now(),
  unique(source, collection, entity_id)
);
create index if not exists ctx_entities_title_trgm on ctx_entities using gin (title gin_trgm_ops);
create index if not exists ctx_entities_summary_trgm on ctx_entities using gin (summary gin_trgm_ops);

-- App settings (AI provider keys etc). Local single-user DB; plaintext-at-rest
-- is acceptable for the demo, revisit with the OS keychain for production.
create table if not exists settings (
  key text primary key,
  value jsonb not null
);
