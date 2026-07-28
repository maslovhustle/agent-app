-- ===========================================================================
-- Compliance Research Agent — initial schema
--
-- Design notes
-- ------------
-- The retrieval layer is parent-child: we EMBED small child chunks (~300
-- chars) so that vector similarity is sharp, but we FEED the LLM the larger
-- parent chunk (~1500 chars) so it has enough surrounding context to reason
-- about a clause instead of a fragment of one.
--
-- Sparse retrieval (BM25-style) runs over the same child chunks via a
-- generated `tsvector` column, so dense and sparse rankings share an ID space
-- and can be fused with Reciprocal Rank Fusion without a join dance.
-- ===========================================================================

create extension if not exists "vector";
create extension if not exists "pg_trgm";
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
create type document_status as enum ('pending', 'processing', 'ready', 'failed');

create table if not exists documents (
  id             uuid primary key default gen_random_uuid(),
  filename       text        not null,
  mime_type      text        not null,
  size_bytes     bigint      not null default 0,
  status         document_status not null default 'pending',
  error_message  text,
  parent_count   integer     not null default 0,
  child_count    integer     not null default 0,
  char_count     integer     not null default 0,
  metadata       jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists documents_status_idx     on documents (status);
create index if not exists documents_created_at_idx on documents (created_at desc);

-- ---------------------------------------------------------------------------
-- document_sources — extracted plain text, kept in its own table so that
-- listing documents in the UI never drags multi-megabyte strings across the
-- wire. Re-chunking a document with new hyperparameters reads from here
-- instead of asking the user to re-upload.
-- ---------------------------------------------------------------------------
create table if not exists document_sources (
  document_id uuid primary key references documents (id) on delete cascade,
  content     text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- parent_chunks — LLM context units. Never embedded, only fetched by id.
-- ---------------------------------------------------------------------------
create table if not exists parent_chunks (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references documents (id) on delete cascade,
  ordinal      integer not null,
  content      text    not null,
  char_count   integer not null,
  metadata     jsonb   not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (document_id, ordinal)
);

create index if not exists parent_chunks_document_idx on parent_chunks (document_id);

-- ---------------------------------------------------------------------------
-- child_chunks — retrieval probes. Dense vector + sparse tsvector on one row.
-- ---------------------------------------------------------------------------
create table if not exists child_chunks (
  id           uuid primary key default gen_random_uuid(),
  parent_id    uuid not null references parent_chunks (id) on delete cascade,
  document_id  uuid not null references documents (id) on delete cascade,
  ordinal      integer not null,
  content      text    not null,
  -- text-embedding-3-small
  embedding    vector(1536),
  fts          tsvector generated always as (to_tsvector('english', content)) stored,
  metadata     jsonb   not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists child_chunks_parent_idx   on child_chunks (parent_id);
create index if not exists child_chunks_document_idx on child_chunks (document_id);

-- Dense index. HNSW gives better recall/latency than IVFFlat at this scale and
-- does not require a training step after bulk loads.
create index if not exists child_chunks_embedding_idx
  on child_chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Sparse index for BM25-style ranking.
create index if not exists child_chunks_fts_idx on child_chunks using gin (fts);

-- ---------------------------------------------------------------------------
-- chat_traces — links a chat turn to its Langfuse trace so the UI can render
-- latency/cost without calling out to Langfuse on every render.
-- ---------------------------------------------------------------------------
create table if not exists chat_traces (
  id             uuid primary key default gen_random_uuid(),
  trace_id       text        not null,
  session_id     text,
  question       text        not null,
  latency_ms     integer     not null default 0,
  prompt_tokens  integer     not null default 0,
  output_tokens  integer     not null default 0,
  total_cost_usd numeric(12, 6) not null default 0,
  verification   text,
  created_at     timestamptz not null default now()
);

create index if not exists chat_traces_created_at_idx on chat_traces (created_at desc);
create index if not exists chat_traces_session_idx    on chat_traces (session_id);

-- ===========================================================================
-- Retrieval functions
-- ===========================================================================

-- Dense retrieval over child chunks. Returns cosine similarity in [0, 1].
create or replace function match_child_chunks (
  query_embedding vector(1536),
  match_count     int  default 20,
  filter_documents uuid[] default null
)
returns table (
  id          uuid,
  parent_id   uuid,
  document_id uuid,
  content     text,
  similarity  float
)
language sql stable
as $$
  select
    c.id,
    c.parent_id,
    c.document_id,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from child_chunks c
  where c.embedding is not null
    and (filter_documents is null or c.document_id = any (filter_documents))
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- Sparse retrieval. `ts_rank_cd` with normalisation 32 approximates BM25's
-- document-length penalty, which matters because parent-child chunking
-- produces uniformly small children where raw tf would otherwise dominate.
create or replace function keyword_search_child_chunks (
  query_text      text,
  match_count     int  default 20,
  filter_documents uuid[] default null
)
returns table (
  id          uuid,
  parent_id   uuid,
  document_id uuid,
  content     text,
  rank        float
)
language sql stable
as $$
  select
    c.id,
    c.parent_id,
    c.document_id,
    c.content,
    ts_rank_cd(c.fts, websearch_to_tsquery('english', query_text), 32) as rank
  from child_chunks c
  where c.fts @@ websearch_to_tsquery('english', query_text)
    and (filter_documents is null or c.document_id = any (filter_documents))
  order by rank desc
  limit match_count;
$$;

-- Parent hydration: given the winning child chunks, fetch the larger contexts.
create or replace function get_parent_contexts (
  parent_ids uuid[]
)
returns table (
  id          uuid,
  document_id uuid,
  ordinal     integer,
  content     text,
  char_count  integer,
  filename    text
)
language sql stable
as $$
  select
    p.id,
    p.document_id,
    p.ordinal,
    p.content,
    p.char_count,
    d.filename
  from parent_chunks p
  join documents d on d.id = p.document_id
  where p.id = any (parent_ids);
$$;

-- ===========================================================================
-- Row Level Security
--
-- The app talks to Postgres exclusively through the service role from server
-- code, which bypasses RLS. Policies are still enabled so that a leaked anon
-- key cannot read the corpus.
-- ===========================================================================
alter table documents        enable row level security;
alter table document_sources enable row level security;
alter table parent_chunks    enable row level security;
alter table child_chunks     enable row level security;
alter table chat_traces      enable row level security;

drop policy if exists "document_sources_service_role" on document_sources;
create policy "document_sources_service_role" on document_sources
  for all to service_role using (true) with check (true);

drop policy if exists "documents_service_role" on documents;
create policy "documents_service_role" on documents
  for all to service_role using (true) with check (true);

drop policy if exists "parent_chunks_service_role" on parent_chunks;
create policy "parent_chunks_service_role" on parent_chunks
  for all to service_role using (true) with check (true);

drop policy if exists "child_chunks_service_role" on child_chunks;
create policy "child_chunks_service_role" on child_chunks
  for all to service_role using (true) with check (true);

drop policy if exists "chat_traces_service_role" on chat_traces;
create policy "chat_traces_service_role" on chat_traces
  for all to service_role using (true) with check (true);

-- Keep `updated_at` honest.
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists documents_touch_updated_at on documents;
create trigger documents_touch_updated_at
  before update on documents
  for each row execute function touch_updated_at();
