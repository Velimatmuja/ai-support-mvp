-- =============================================================================
-- Website -> Knowledge Base: burime njohurish, crawl jobs me radhë pune në Postgres,
-- metadata e faqeve te `documents`, çelësa API për plugin-in WordPress.
--
-- Parime (si te migrimi fillestar):
--   * Çdo tabelë ka tenant_id + RLS; paneli vetëm LEXON (select) me RLS.
--   * Çdo shkrim (krijim burimi, nisje crawl-i, fshirje) kalon nga API routes me
--     çelësin secret dhe tenant_id nga burim i besuar.
--   * Worker-i (cron/proces më vete) merr punë me `for update skip locked` + lease:
--     dy worker-a nuk përpunojnë kurrë të njëjtin URL njëkohësisht, dhe një worker
--     që vdes në mes e liron punën kur i skadon lease.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- KUFIJTË E PLANIT (vetëm serveri i ndryshon: grant-i i update te tenants është
-- vetëm për name/allowed_origins/settings)
-- -----------------------------------------------------------------------------
alter table public.tenants
  add column max_sources        integer not null default 2    check (max_sources >= 0),
  add column max_crawl_pages    integer not null default 200  check (max_crawl_pages >= 0),
  add column max_kb_chunks      integer not null default 4000 check (max_kb_chunks >= 0),
  add column min_sync_interval_hours integer not null default 24 check (min_sync_interval_hours >= 1);

-- -----------------------------------------------------------------------------
-- BURIMET E NJOHURIVE
-- -----------------------------------------------------------------------------
create table public.knowledge_sources (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants (id) on delete cascade,
  knowledge_base_id    uuid not null references public.knowledge_bases (id) on delete cascade,
  type                 text not null default 'website' check (type in ('website')),
  -- URL-ja e normalizuar që regjistroi klienti (p.sh. https://dyqani.al/).
  root_url             text not null check (char_length(root_url) <= 2000),
  -- Host-i i lejuar për crawl (pa www.); crawl-i nuk del kurrë jashtë tij.
  host                 text not null check (char_length(host) between 1 and 253),
  -- Burim i çaktivizuar: chunks e tij nuk përdoren në përgjigje, sync-u ndalet.
  enabled              boolean not null default true,
  -- Pronësia e domain-it: meta tag ose /.well-known/anesp-verification.txt.
  verification_token   text not null default ('anesp-' || replace(gen_random_uuid()::text, '-', '')),
  verified_at          timestamptz,
  -- Konfigurimi i crawl-it (kufizohet gjithmonë edhe nga plani i tenant-it).
  max_pages            integer not null default 100 check (max_pages between 1 and 5000),
  max_depth            integer not null default 3   check (max_depth between 0 and 10),
  -- Prefikse rrugësh ose modele me * (p.sh. /blog/*, /tag/); krahasohen me path+query.
  exclude_patterns     text[] not null default '{}' check (cardinality(exclude_patterns) <= 100),
  sync_interval_hours  integer not null default 168 check (sync_interval_hours between 1 and 8760),
  next_sync_at         timestamptz,
  -- Statusi i fundit për UI: pending | crawling | indexing | ready | failed
  status               text not null default 'pending'
                       check (status in ('pending', 'crawling', 'indexing', 'ready', 'failed')),
  last_job_id          uuid,
  last_synced_at       timestamptz,
  -- Hash-et e paragrafëve boilerplate nga crawl-i i fundit me mostër të mjaftueshme.
  boilerplate          text[] not null default '{}',
  created_at           timestamptz not null default now(),
  unique (tenant_id, host)
);
create index knowledge_sources_tenant_idx on public.knowledge_sources (tenant_id);
create index knowledge_sources_due_idx on public.knowledge_sources (next_sync_at)
  where enabled and verified_at is not null;

-- -----------------------------------------------------------------------------
-- DOKUMENTET: faqet e crawl-uara janë dokumente me source_id + url
-- -----------------------------------------------------------------------------
alter table public.documents
  add column source_id      uuid references public.knowledge_sources (id) on delete cascade,
  add column url            text check (char_length(url) <= 2000),
  add column enabled        boolean not null default true,
  add column language       text check (char_length(language) <= 12),
  add column description    text check (char_length(description) <= 500),
  add column etag           text check (char_length(etag) <= 300),
  add column last_modified  text check (char_length(last_modified) <= 100),
  add column published_at   timestamptz,
  add column modified_at    timestamptz,
  add column last_seen_job_id uuid,
  add column indexed_at     timestamptz,
  add column updated_at     timestamptz not null default now();

alter table public.documents drop constraint documents_source_type_check;
alter table public.documents add constraint documents_source_type_check
  check (source_type in ('text', 'file', 'web'));
alter table public.documents add constraint documents_web_has_url
  check ((source_type = 'web') = (source_id is not null and url is not null));

-- Dublikatat: teksti manual i njëjtë refuzohet si më parë; faqet web janë unike për URL
-- brenda burimit (dy faqe me përmbajtje identike trajtohen nga crawler-i).
alter table public.documents drop constraint documents_tenant_id_content_hash_key;
create unique index documents_manual_hash_key on public.documents (tenant_id, content_hash)
  where source_id is null;
create unique index documents_source_url_key on public.documents (source_id, url)
  where source_id is not null;
create index documents_tenant_idx on public.documents (tenant_id, created_at desc);

-- Hash i chunk-ut: kur një faqe ndryshon pak, chunks e pandryshuara ripërdorin
-- embedding-un e vjetër (pa thirrje të re te ofruesi).
alter table public.document_chunks add column content_hash text;
create index document_chunks_doc_hash_idx on public.document_chunks (document_id, content_hash);

-- -----------------------------------------------------------------------------
-- CRAWL JOBS
-- -----------------------------------------------------------------------------
create table public.crawl_jobs (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  source_id          uuid not null references public.knowledge_sources (id) on delete cascade,
  trigger            text not null check (trigger in ('initial', 'manual', 'scheduled', 'retry')),
  status             text not null default 'pending'
                     check (status in ('pending', 'crawling', 'indexing', 'ready', 'failed', 'cancelled')),
  -- Kufijtë e ngrirë në momentin e krijimit (plani mund të ndryshojë gjatë job-it).
  max_pages          integer not null,
  max_depth          integer not null,
  pages_discovered   integer not null default 0,
  pages_processed    integer not null default 0,
  pages_failed       integer not null default 0,
  pages_skipped      integer not null default 0,
  pages_unchanged    integer not null default 0,
  pages_indexed      integer not null default 0,
  pages_deleted      integer not null default 0,
  chunks_embedded    integer not null default 0,
  chunks_reused      integer not null default 0,
  embedding_tokens   integer not null default 0,
  -- truncated: u arrit max_pages ose kufiri i chunks. incomplete: një sitemap nuk u
  -- lexua dot. Në të dyja rastet crawl-i nuk fshin faqet që nuk i pa.
  truncated          boolean not null default false,
  incomplete         boolean not null default false,
  -- robots.txt i lexuar një herë për job (teksti i papërpunuar, i kufizuar).
  robots_txt         text check (char_length(robots_txt) <= 100000),
  crawl_delay_ms     integer not null default 0,
  -- Paragrafë që përsëriten në shumicën e faqeve (menu, footer): hash-et e tyre.
  boilerplate        text[] not null default '{}',
  -- Riprovim me backoff kur një tick dështon pa pritur.
  attempts           integer not null default 0,
  next_run_at        timestamptz not null default now(),
  lease_until        timestamptz,
  locked_by          text,
  error              text check (char_length(error) <= 500),
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz not null default now()
);
create index crawl_jobs_tenant_idx on public.crawl_jobs (tenant_id, created_at desc);
create index crawl_jobs_source_idx on public.crawl_jobs (source_id, created_at desc);
create index crawl_jobs_runnable_idx on public.crawl_jobs (next_run_at)
  where status in ('pending', 'crawling', 'indexing');
-- Idempotencë: një burim ka të shumtën një job aktiv. Një "sync" i dytë kthen të parin.
create unique index crawl_jobs_one_active_per_source on public.crawl_jobs (source_id)
  where status in ('pending', 'crawling', 'indexing');

alter table public.knowledge_sources
  add constraint knowledge_sources_last_job_fk
  foreign key (last_job_id) references public.crawl_jobs (id) on delete set null;

-- Radha e URL-ve të një job-i (frontier). Teksti i nxjerrë rri këtu përkohësisht,
-- derisa faza e indeksimit ta kthejë në chunks; pastaj fshihet.
create table public.crawl_queue (
  id              bigint generated always as identity primary key,
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  job_id          uuid not null references public.crawl_jobs (id) on delete cascade,
  url             text not null check (char_length(url) <= 2000),
  depth           integer not null default 0,
  from_sitemap    boolean not null default false,
  -- pending -> fetched (teksti gati) -> indexed | unchanged | skipped | failed
  status          text not null default 'pending'
                  check (status in ('pending', 'fetched', 'indexed', 'unchanged', 'skipped', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  http_status     integer,
  reason          text check (char_length(reason) <= 300),
  -- Rezultati i nxjerrjes: { title, description, canonical, lang, text, ... }
  extracted       jsonb,
  para_hashes     text[],
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (job_id, url)
);
create index crawl_queue_job_status_idx on public.crawl_queue (job_id, status, next_attempt_at);
create index crawl_queue_tenant_idx on public.crawl_queue (tenant_id);

-- Ngjarje për monitorim (pa sekrete, pa body të faqeve).
create table public.crawl_job_events (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  job_id      uuid not null references public.crawl_jobs (id) on delete cascade,
  level       text not null check (level in ('info', 'warn', 'error')),
  code        text not null check (char_length(code) <= 60),
  message     text check (char_length(message) <= 500),
  url         text check (char_length(url) <= 2000),
  created_at  timestamptz not null default now()
);
create index crawl_job_events_job_idx on public.crawl_job_events (job_id, id);
create index crawl_job_events_tenant_idx on public.crawl_job_events (tenant_id, created_at desc);

-- -----------------------------------------------------------------------------
-- ÇELËSA API (server-me-server, p.sh. plugin-i WordPress). Ruhet vetëm SHA-256
-- e çelësit; teksti i plotë shfaqet një herë. Lexohen vetëm nga serveri.
-- -----------------------------------------------------------------------------
create table public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  created_by    uuid references auth.users (id) on delete set null,
  name          text not null check (char_length(name) between 1 and 120),
  -- 8 karakteret e para, për t'u njohur në UI pa e zbuluar çelësin.
  prefix        text not null check (char_length(prefix) between 4 and 16),
  key_hash      text not null unique check (char_length(key_hash) = 64),
  scopes        text[] not null default '{kb}',
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index api_keys_tenant_idx on public.api_keys (tenant_id);

-- usage_events: crawl-i regjistron embeddings si më parë ('embedding').

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- -----------------------------------------------------------------------------
alter table public.knowledge_sources enable row level security;
alter table public.crawl_jobs        enable row level security;
alter table public.crawl_queue       enable row level security;
alter table public.crawl_job_events  enable row level security;
alter table public.api_keys          enable row level security;

create policy knowledge_sources_select_own on public.knowledge_sources
  for select to authenticated
  using (tenant_id = (select private.tenant_id()));

create policy crawl_jobs_select_own on public.crawl_jobs
  for select to authenticated
  using (tenant_id = (select private.tenant_id()));

create policy crawl_job_events_select_own on public.crawl_job_events
  for select to authenticated
  using (tenant_id = (select private.tenant_id()));

-- Pronari sheh çelësat e vet (emri, prefiksi, data), jo hash-in (shih grant-et).
create policy api_keys_select_own on public.api_keys
  for select to authenticated
  using (tenant_id = (select private.tenant_id()));

-- crawl_queue: asnjë politikë => vetëm serveri (përmban tekst të papërpunuar).

revoke all on
  public.knowledge_sources, public.crawl_jobs, public.crawl_queue,
  public.crawl_job_events, public.api_keys
from public, anon, authenticated;

grant select on public.knowledge_sources to authenticated;
grant select (id, tenant_id, source_id, trigger, status, max_pages, max_depth, pages_discovered,
              pages_processed, pages_failed, pages_skipped, pages_unchanged, pages_indexed,
              pages_deleted, chunks_embedded, chunks_reused, embedding_tokens, truncated, incomplete,
              attempts, error, started_at, finished_at, created_at)
  on public.crawl_jobs to authenticated;
grant select on public.crawl_job_events to authenticated;
grant select (id, tenant_id, name, prefix, scopes, last_used_at, revoked_at, created_at)
  on public.api_keys to authenticated;

grant select, insert, update, delete on
  public.knowledge_sources, public.crawl_jobs, public.crawl_queue,
  public.crawl_job_events, public.api_keys
to service_role;

-- -----------------------------------------------------------------------------
-- RPC — vetëm serveri
-- -----------------------------------------------------------------------------

-- Kërkimi hibrid tani: (1) përjashton dokumentet/burimet e çaktivizuara,
-- (2) kthen URL-në burimore për referenca, (3) tregon nëse chunk-u u gjet edhe
-- me full-text (sinjal relevance pavarësisht nga similarity).
drop function public.match_chunks(uuid, extensions.vector, text, integer);
create function public.match_chunks(
  p_tenant_id        uuid,
  p_query_embedding  extensions.vector(512),
  p_query_text       text,
  p_match_count      integer default 6
)
returns table (
  id              bigint,
  document_id     uuid,
  document_title  text,
  document_url    text,
  content         text,
  similarity      double precision,
  score           double precision,
  fts_match       boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with usable as (
    select c.id, c.embedding, c.fts
    from public.document_chunks c
    join public.documents d on d.id = c.document_id
    left join public.knowledge_sources s on s.id = d.source_id
    where c.tenant_id = p_tenant_id
      and d.tenant_id = p_tenant_id
      and d.status = 'ready'
      and d.enabled
      and (d.source_id is null or (s.enabled and s.tenant_id = p_tenant_id))
  ),
  semantic as (
    select u.id,
           1 - (u.embedding operator(extensions.<=>) p_query_embedding) as similarity,
           row_number() over (
             order by u.embedding operator(extensions.<=>) p_query_embedding
           ) as rank_ix
    from usable u
    order by u.embedding operator(extensions.<=>) p_query_embedding
    limit least(p_match_count, 20) * 3
  ),
  full_text as (
    select u.id,
           row_number() over (
             order by cov.matched desc, ts_rank_cd(u.fts, q.tsq) desc, u.id
           ) as rank_ix
    from usable u,
         lateral (
           select nullif(replace(plainto_tsquery('simple', p_query_text)::text, '&', '|'), '')::tsquery as tsq
         ) q,
         lateral (
           select count(*) as matched
           from unnest(tsvector_to_array(u.fts)) as lexeme
           where lexeme = any (tsvector_to_array(to_tsvector('simple', p_query_text)))
         ) cov
    where q.tsq is not null
      and u.fts @@ q.tsq
    order by cov.matched desc, ts_rank_cd(u.fts, q.tsq) desc, u.id
    limit least(p_match_count, 20) * 3
  ),
  fused as (
    select coalesce(s.id, f.id) as id,
           s.similarity,
           f.id is not null as fts_match,
           coalesce(1.0 / (60 + s.rank_ix), 0.0) + coalesce(1.0 / (60 + f.rank_ix), 0.0) as score
    from semantic s
    full outer join full_text f on f.id = s.id
  )
  select c.id,
         c.document_id,
         d.title,
         d.url,
         c.content,
         coalesce(fu.similarity,
                  1 - (c.embedding operator(extensions.<=>) p_query_embedding))::double precision,
         fu.score::double precision,
         fu.fts_match
  from fused fu
  join public.document_chunks c on c.id = fu.id
  join public.documents d on d.id = c.document_id
  where c.tenant_id = p_tenant_id
  order by fu.score desc, c.id
  limit least(p_match_count, 20);
$$;

-- Merr job-in e radhës që mund të përpunohet dhe i vendos lease. `skip locked`:
-- worker-at paralelë marrin job-e të ndryshme, pa pritur njëri-tjetrin.
create or replace function public.claim_crawl_job(p_worker text, p_lease_seconds integer)
returns public.crawl_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.crawl_jobs;
begin
  select * into v_job
  from public.crawl_jobs j
  where j.status in ('pending', 'crawling', 'indexing')
    and j.next_run_at <= now()
    and (j.lease_until is null or j.lease_until < now())
  order by j.next_run_at, j.created_at
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  update public.crawl_jobs
  set lease_until = now() + make_interval(secs => p_lease_seconds),
      locked_by = p_worker,
      started_at = coalesce(started_at, now()),
      status = case when status = 'pending' then 'crawling' else status end
  where id = v_job.id
  returning * into v_job;

  return v_job;
end;
$$;

-- Merr deri në p_limit URL nga radha e job-it. Ekskluziviteti vjen nga lease-i i
-- job-it (vetëm një worker mban një job), jo nga lock-e rreshtash.
create or replace function public.claim_crawl_urls(p_job_id uuid, p_limit integer)
returns setof public.crawl_queue
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from public.crawl_queue q
  where q.job_id = p_job_id
    and q.status = 'pending'
    and q.next_attempt_at <= now()
  order by q.depth, q.id
  limit greatest(least(p_limit, 50), 0);
$$;

-- Paragrafët që shfaqen në të paktën p_min_pages faqe të job-it = boilerplate.
create or replace function public.crawl_boilerplate(p_job_id uuid, p_min_pages integer)
returns text[]
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(array_agg(h), '{}')
  from (
    select h
    from public.crawl_queue q, unnest(q.para_hashes) as h
    where q.job_id = p_job_id and q.status = 'fetched'
    group by h
    having count(distinct q.id) >= p_min_pages
  ) x;
$$;

-- Krijon job-e për burimet që u ka ardhur radha e riskanimit. Idempotent:
-- indeksi unik i job-it aktiv ndalon dyfishimin edhe kur dy cron-e nisen njëherësh.
create or replace function public.enqueue_due_syncs(p_limit integer default 20)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source record;
  v_count integer := 0;
begin
  for v_source in
    select s.id, s.tenant_id, s.max_pages, s.max_depth, t.max_crawl_pages
    from public.knowledge_sources s
    join public.tenants t on t.id = s.tenant_id
    where s.enabled
      and s.verified_at is not null
      and s.next_sync_at is not null
      and s.next_sync_at <= now()
      and t.status = 'active'
      and t.trial_ends_at > now()
    order by s.next_sync_at
    limit greatest(least(p_limit, 100), 0)
    for update of s skip locked
  loop
    insert into public.crawl_jobs (tenant_id, source_id, trigger, max_pages, max_depth)
    values (v_source.tenant_id, v_source.id, 'scheduled',
            least(v_source.max_pages, v_source.max_crawl_pages), v_source.max_depth)
    on conflict (source_id) where status in ('pending', 'crawling', 'indexing') do nothing;
    if found then
      v_count := v_count + 1;
    end if;
    -- Edhe kur ka job aktiv, shtyje afatin që cron-i të mos e provojë çdo minutë.
    update public.knowledge_sources s
    set next_sync_at = now() + make_interval(hours => greatest(s.sync_interval_hours, 1))
    where s.id = v_source.id;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.match_chunks(uuid, extensions.vector, text, integer) from public, anon, authenticated;
revoke all on function public.claim_crawl_job(text, integer) from public, anon, authenticated;
revoke all on function public.claim_crawl_urls(uuid, integer) from public, anon, authenticated;
revoke all on function public.crawl_boilerplate(uuid, integer) from public, anon, authenticated;
revoke all on function public.enqueue_due_syncs(integer) from public, anon, authenticated;

grant execute on function public.match_chunks(uuid, extensions.vector, text, integer) to service_role;
grant execute on function public.claim_crawl_job(text, integer) to service_role;
grant execute on function public.claim_crawl_urls(uuid, integer) to service_role;
grant execute on function public.crawl_boilerplate(uuid, integer) to service_role;
grant execute on function public.enqueue_due_syncs(integer) to service_role;

-- Pa Realtime për crawl_jobs: grant-et janë për kolona dhe paneli thjesht bën polling
-- çdo disa sekonda vetëm kur ka job aktiv.
