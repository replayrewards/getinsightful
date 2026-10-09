-- Memory core: durable memories (facts/procedures/preferences/learnings) with
-- an approval flow, chat session persistence, and FTS columns so context
-- search ranks by relevance (ts_rank) as well as trigram similarity.

create table if not exists memories (
  id bigserial primary key,
  kind text not null check (kind in ('fact', 'preference', 'procedure', 'learning')),
  text text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  source text not null default 'chat',
  provenance jsonb not null default '{}', -- {session_id, question} for chat learnings
  created_at timestamptz not null default now()
);
-- dedupe: the same learning extracted twice lands once
create unique index if not exists memories_text_md5 on memories (lower(md5(text)));
create index if not exists memories_text_trgm on memories using gin (text gin_trgm_ops);
create index if not exists memories_status_idx on memories (status, created_at desc);

-- relevance-ranked search over entities (title + summary)
alter table ctx_entities add column if not exists tsv tsvector
  generated always as (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, ''))) stored;
create index if not exists ctx_entities_tsv on ctx_entities using gin (tsv);

alter table memories add column if not exists tsv tsvector
  generated always as (to_tsvector('english', text)) stored;
create index if not exists memories_tsv on memories using gin (tsv);

-- chat history: sessions are replaced wholesale on each request, so the
-- client stays the source of truth while history survives restarts.
create table if not exists chat_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists chat_messages (
  id bigserial primary key,
  session_id uuid not null references chat_sessions(id) on delete cascade,
  seq int not null,
  role text not null check (role in ('user', 'assistant')),
  content jsonb not null,
  unique (session_id, seq)
);
