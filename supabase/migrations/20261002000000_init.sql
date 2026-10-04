-- =============================================================================
-- AI Support MVP — skema fillestare (multi-tenant, RLS, RAG)
-- Kanalet: web widget + Telegram.
--
-- Modeli i sigurisë:
--   * Paneli (browser) flet me Supabase me çelësin publishable + JWT të përdoruesit
--     -> roli `authenticated` -> RLS kufizon gjithçka te tenant-i i tij.
--   * Serveri (Vercel API routes) përdor çelësin secret -> roli `service_role`
--     -> anashkalon RLS. Prandaj serveri e nxjerr GJITHMONË tenant_id nga një
--     burim i besuar (widget_key, channel id + secret, JWT) dhe kurrë nga body.
--   * Vizitorët e widget-it dhe Telegram NUK flasin kurrë direkt me Supabase.
-- =============================================================================

create extension if not exists vector with schema extensions;

create schema if not exists private;

-- -----------------------------------------------------------------------------
-- TABELAT
-- -----------------------------------------------------------------------------

create table public.tenants (
  id                        uuid primary key default gen_random_uuid(),
  name                      text not null check (char_length(name) between 1 and 120),
  -- Identifikues PUBLIK për widget-in (jo sekret). Nuk ekspozojmë UUID-në e tenant-it.
  widget_key                text not null unique
                            default ('wk_' || replace(gen_random_uuid()::text, '-', '')),
  -- Origjinat ku lejohet widget-i, p.sh. {https://dyqani.al}. Bosh = çdo origjinë (vetëm pilot).
  allowed_origins           text[] not null default '{}',
  -- bot_name, welcome_message, color, fallback_message, extra_instructions
  settings                  jsonb not null default '{}'::jsonb,
  plan                      text not null default 'pilot',
  status                    text not null default 'active'
                            check (status in ('active', 'suspended')),
  monthly_ai_reply_limit    integer not null default 300 check (monthly_ai_reply_limit >= 0),
  trial_ends_at             timestamptz not null default (now() + interval '30 days'),
  created_at                timestamptz not null default now()
);

-- Profili i përdoruesit të panelit. 1 përdorues = 1 tenant (mjafton për MVP).
create table public.users (
  id          uuid primary key references auth.users (id) on delete cascade,
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  email       text not null,
  role        text not null default 'owner' check (role in ('owner', 'agent')),
  created_at  timestamptz not null default now()
);
create index users_tenant_id_idx on public.users (tenant_id);

create table public.channels (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  type          text not null check (type in ('widget', 'telegram')),
  -- Telegram: id numerike e bot-it. Widget: null.
  external_id   text,
  display_name  text,
  status        text not null default 'active' check (status in ('active', 'disabled')),
  created_at    timestamptz not null default now()
);
create index channels_tenant_id_idx on public.channels (tenant_id);
-- Një bot Telegrami mund t'i përkasë vetëm një tenant-i.
create unique index channels_type_external_id_key
  on public.channels (type, external_id) where external_id is not null;
-- Një kanal widget për tenant.
create unique index channels_one_widget_per_tenant
  on public.channels (tenant_id) where type = 'widget';

-- Sekretet e kanaleve (token i bot-it, sekreti i webhook-ut).
-- RLS aktiv + ASNJË politikë + asnjë GRANT për anon/authenticated
-- => i lexueshëm vetëm nga serveri (service_role).
create table public.channel_secrets (
  channel_id      uuid primary key references public.channels (id) on delete cascade,
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  -- Token i bot-it i enkriptuar nga serveri (AES-256-GCM, çelësi në env, jo në DB).
  bot_token_enc   text not null,
  webhook_secret  text not null,
  created_at      timestamptz not null default now()
);
create index channel_secrets_tenant_id_idx on public.channel_secrets (tenant_id);

create table public.conversations (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  channel_id        uuid not null references public.channels (id) on delete cascade,
  channel_type      text not null check (channel_type in ('widget', 'telegram')),
  -- Widget: visitor id (uuid e rastësishme). Telegram: chat id.
  external_user_id  text not null,
  contact_name      text,
  status            text not null default 'open' check (status in ('open', 'handoff', 'closed')),
  ai_enabled        boolean not null default true,
  -- Pse u kalua te njeriu: 'ai_requested' | 'quota' | 'trial_ended' | 'agent_took_over'
  handoff_reason    text,
  last_message_at   timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (channel_id, external_user_id)
);
create index conversations_tenant_last_msg_idx
  on public.conversations (tenant_id, last_message_at desc);

create table public.messages (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  role             text not null check (role in ('user', 'assistant', 'agent', 'system')),
  content          text not null check (char_length(content) <= 8000),
  -- Id e ngjarjes te kanali (p.sh. 'tg:<update_id>') për idempotencë.
  external_id      text,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, id);
create index messages_tenant_created_idx on public.messages (tenant_id, created_at desc);
-- I njëjti update i Telegramit i ridërguar nuk krijon mesazh të dytë.
create unique index messages_conversation_external_id_key
  on public.messages (conversation_id, external_id) where external_id is not null;

create table public.knowledge_bases (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  name        text not null default 'Default',
  created_at  timestamptz not null default now()
);
create index knowledge_bases_tenant_id_idx on public.knowledge_bases (tenant_id);

create table public.documents (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  knowledge_base_id  uuid not null references public.knowledge_bases (id) on delete cascade,
  title              text not null check (char_length(title) between 1 and 200),
  source_type        text not null default 'text' check (source_type in ('text', 'file')),
  status             text not null default 'processing'
                     check (status in ('processing', 'ready', 'failed')),
  content_hash       text not null,
  char_count         integer not null default 0,
  chunk_count        integer not null default 0,
  created_at         timestamptz not null default now(),
  unique (tenant_id, content_hash)
);
create index documents_kb_idx on public.documents (knowledge_base_id);

create table public.document_chunks (
  id                 bigint generated always as identity primary key,
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  knowledge_base_id  uuid not null references public.knowledge_bases (id) on delete cascade,
  document_id        uuid not null references public.documents (id) on delete cascade,
  chunk_index        integer not null,
  content            text not null,
  -- voyage-4-lite me output_dimension = 512
  embedding          extensions.vector(512) not null,
  -- 'simple' = pa stemming: punon njësoj për shqip, anglisht, emra produktesh, kode.
  fts                tsvector generated always as (to_tsvector('simple', content)) stored,
  created_at         timestamptz not null default now()
);
-- Kërkimi vektorial bëhet i saktë (exact scan) brenda një tenant-i: ky indeks e
-- ngushton te rreshtat e tenant-it. Me pak mijëra chunks për tenant është <10 ms
-- dhe ka recall 100%. Shto HNSW vetëm kur një tenant kalon ~50k chunks
-- (dhe atëherë përdor `set hnsw.iterative_scan = strict_order`).
create index document_chunks_tenant_idx on public.document_chunks (tenant_id);
create index document_chunks_document_idx on public.document_chunks (document_id);
create index document_chunks_kb_idx on public.document_chunks (knowledge_base_id);
create index document_chunks_fts_idx on public.document_chunks using gin (fts);

-- Ledger i përdorimit: BURIMI I SË VËRTETËS për kuota/faturim. Vetëm INSERT.
create table public.usage_events (
  id                 bigint generated always as identity primary key,
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  conversation_id    uuid references public.conversations (id) on delete set null,
  message_id         bigint references public.messages (id) on delete set null,
  event_type         text not null check (event_type in ('ai_reply', 'embedding')),
  channel_type       text,
  model              text,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cost_usd           numeric(12, 6) not null default 0,
  langfuse_trace_id  text,
  created_at         timestamptz not null default now()
);
create index usage_events_tenant_created_idx on public.usage_events (tenant_id, created_at desc);
create index usage_events_conversation_idx on public.usage_events (conversation_id);
create index usage_events_message_idx on public.usage_events (message_id);

-- Numërues për rate limiting (dritare fikse). Vetëm serveri.
create table public.rate_limits (
  bucket        text not null,
  window_start  timestamptz not null,
  count         integer not null default 1,
  primary key (bucket, window_start)
);

-- -----------------------------------------------------------------------------
-- FUNKSIONE NDIHMËSE (schema private: nuk ekspozohet nga Data API)
-- -----------------------------------------------------------------------------

-- Tenant-i i përdoruesit të loguar. SECURITY DEFINER sepse lexon public.users
-- pa u varur nga RLS e vetë asaj tabele (shmang rekursionin në politika).
create or replace function private.tenant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.tenant_id from public.users u where u.id = (select auth.uid());
$$;

revoke all on function private.tenant_id() from public;
grant usage on schema private to authenticated;
grant execute on function private.tenant_id() to authenticated;

-- Regjistrim i ri -> krijo tenant + profil owner + knowledge base + kanal widget.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_name text;
begin
  -- raw_user_meta_data është e editueshme nga përdoruesi: përdoret VETËM si emër
  -- për shfaqje, kurrë për autorizim.
  v_name := left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'business_name'), ''),
                          split_part(new.email, '@', 1),
                          'Biznesi im'), 120);

  insert into public.tenants (name) values (v_name) returning id into v_tenant_id;

  insert into public.users (id, tenant_id, email, role)
  values (new.id, v_tenant_id, coalesce(new.email, ''), 'owner');

  insert into public.knowledge_bases (tenant_id, name) values (v_tenant_id, 'Default');

  insert into public.channels (tenant_id, type, display_name)
  values (v_tenant_id, 'widget', 'Web widget');

  return new;
end;
$$;

revoke all on function private.handle_new_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- -----------------------------------------------------------------------------

alter table public.tenants          enable row level security;
alter table public.users            enable row level security;
alter table public.channels         enable row level security;
alter table public.channel_secrets  enable row level security;
alter table public.conversations    enable row level security;
alter table public.messages         enable row level security;
alter table public.knowledge_bases  enable row level security;
alter table public.documents        enable row level security;
alter table public.document_chunks  enable row level security;
alter table public.usage_events     enable row level security;
alter table public.rate_limits      enable row level security;

-- (select private.tenant_id()) vlerësohet një herë për query, jo për çdo rresht.

create policy tenants_select_own on public.tenants
  for select to authenticated
  using (id = (select private.tenant_id()));

create policy tenants_update_own on public.tenants
  for update to authenticated
  using (id = (select private.tenant_id()))
  with check (id = (select private.tenant_id()));

create policy users_select_same_tenant on public.users
  for select to authenticated
  using (tenant_id = (select private.tenant_id()));

create policy channels_select_own on public.channels
  for select to authenticated
  using (tenant_id = (select private.tenant_id()));

create policy conversations_select_own on public.conversations
  for select to authenticated
  using (tenant_id = (select private.tenant_id()));

create policy conversations_update_own on public.conversations
  for update to authenticated
  using (tenant_id = (select private.tenant_id()))
  with check (tenant_id = (select private.tenant_id()));

create policy messages_select_own on public.messages
  for select to authenticated
  using (tenant_id = (select private.tenant_id()));

create policy knowledge_bases_select_own on public.knowledge_bases
  for select to authenticated
  using (tenant_id = (select private.tenant_id()));

create policy documents_select_own on public.documents
  for select to authenticated
  using (tenant_id = (select private.tenant_id()));

create policy documents_delete_own on public.documents
  for delete to authenticated
  using (tenant_id = (select private.tenant_id()));

create policy document_chunks_select_own on public.document_chunks
  for select to authenticated
  using (tenant_id = (select private.tenant_id()));

create policy usage_events_select_own on public.usage_events
  for select to authenticated
  using (tenant_id = (select private.tenant_id()));

-- channel_secrets dhe rate_limits: asnjë politikë => asnjë akses nga klienti.

-- -----------------------------------------------------------------------------
-- GRANTS (tabelat e reja nuk ekspozohen më automatikisht te Data API)
-- Parimi: privilegji minimal. `anon` nuk merr asgjë.
-- -----------------------------------------------------------------------------

revoke all on
  public.tenants, public.users, public.channels, public.channel_secrets,
  public.conversations, public.messages, public.knowledge_bases, public.documents,
  public.document_chunks, public.usage_events, public.rate_limits
from public, anon, authenticated;

grant select on public.tenants to authenticated;
-- Tenant-i mund të ndryshojë VETËM këto kolona. plan / status /
-- monthly_ai_reply_limit / trial_ends_at / widget_key mbeten vetëm për serverin.
grant update (name, allowed_origins, settings) on public.tenants to authenticated;

grant select on public.users            to authenticated;
grant select on public.channels         to authenticated;
grant select on public.conversations    to authenticated;
grant update (status, ai_enabled) on public.conversations to authenticated;
grant select on public.messages         to authenticated;
grant select on public.knowledge_bases  to authenticated;
grant select, delete on public.documents to authenticated;
-- Pa kolonat embedding/fts: paneli nuk ka pse t'i shkarkojë.
grant select (id, tenant_id, knowledge_base_id, document_id, chunk_index, content, created_at)
  on public.document_chunks to authenticated;
grant select on public.usage_events     to authenticated;

grant select, insert, update, delete on
  public.tenants, public.users, public.channels, public.channel_secrets,
  public.conversations, public.messages, public.knowledge_bases, public.documents,
  public.document_chunks, public.usage_events, public.rate_limits
to service_role;

-- -----------------------------------------------------------------------------
-- REALTIME — vetëm për panelin (agjentë të loguar). RLS zbatohet edhe këtu:
-- një agjent merr vetëm ngjarjet e tenant-it të vet. Widget-i NUK përdor Realtime.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.messages, public.conversations;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- RPC — thirren VETËM nga serveri (service_role)
-- -----------------------------------------------------------------------------

-- Kërkim hibrid: vektor (kuptim) + full-text (fjalë të sakta), i bashkuar me
-- Reciprocal Rank Fusion. Filtri i tenant-it është brenda funksionit.
create or replace function public.match_chunks(
  p_tenant_id        uuid,
  p_query_embedding  extensions.vector(512),
  p_query_text       text,
  p_match_count      integer default 6
)
returns table (
  id              bigint,
  document_id     uuid,
  document_title  text,
  content         text,
  similarity      double precision,
  score           double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with semantic as (
    select c.id,
           1 - (c.embedding operator(extensions.<=>) p_query_embedding) as similarity,
           row_number() over (
             order by c.embedding operator(extensions.<=>) p_query_embedding
           ) as rank_ix
    from public.document_chunks c
    where c.tenant_id = p_tenant_id
    order by c.embedding operator(extensions.<=>) p_query_embedding
    limit least(p_match_count, 20) * 3
  ),
  full_text as (
    select c.id,
           row_number() over (
             order by cov.matched desc, ts_rank_cd(c.fts, q.tsq) desc, c.id
           ) as rank_ix
    from public.document_chunks c,
         -- OR midis fjalëve: një pyetje e gjatë nuk duhet të kërkojë të gjitha fjalët.
         lateral (
           select nullif(replace(plainto_tsquery('simple', p_query_text)::text, '&', '|'), '')::tsquery as tsq
         ) q,
         -- Sa fjalë TË NDRYSHME të pyetjes gjenden në chunk. 'simple' nuk heq fjalë
         -- të zakonshme ("are", "the", "për", "dhe"); renditja sipas mbulimit e
         -- pengon një chunk që përsërit një fjalë të tillë të dalë i pari.
         lateral (
           select count(*) as matched
           from unnest(tsvector_to_array(c.fts)) as lexeme
           where lexeme = any (tsvector_to_array(to_tsvector('simple', p_query_text)))
         ) cov
    where c.tenant_id = p_tenant_id
      and q.tsq is not null
      and c.fts @@ q.tsq
    order by cov.matched desc, ts_rank_cd(c.fts, q.tsq) desc, c.id
    limit least(p_match_count, 20) * 3
  ),
  fused as (
    select coalesce(s.id, f.id) as id,
           s.similarity,
           coalesce(1.0 / (60 + s.rank_ix), 0.0) + coalesce(1.0 / (60 + f.rank_ix), 0.0) as score
    from semantic s
    full outer join full_text f on f.id = s.id
  )
  select c.id,
         c.document_id,
         d.title,
         c.content,
         coalesce(fu.similarity,
                  1 - (c.embedding operator(extensions.<=>) p_query_embedding))::double precision,
         fu.score::double precision
  from fused fu
  join public.document_chunks c on c.id = fu.id
  join public.documents d on d.id = c.document_id
  where c.tenant_id = p_tenant_id
    and d.status = 'ready'
  order by fu.score desc, c.id
  limit least(p_match_count, 20);
$$;

-- Rate limit atomik me dritare fikse. Kthen true nëse kërkesa lejohet.
create or replace function public.check_rate_limit(
  p_bucket          text,
  p_limit           integer,
  p_window_seconds  integer
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_count  integer;
begin
  v_window := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.rate_limits as rl (bucket, window_start, count)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start)
  do update set count = rl.count + 1
  returning rl.count into v_count;

  -- Pastrim oportunist (~1% e thirrjeve) që tabela të mos rritet pa fund.
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;

  return v_count <= p_limit;
end;
$$;

-- Gjen ose krijon bisedën e një vizitori/chat-i në një kanal.
-- Tenant-i merret nga vetë kanali, jo nga thirrësi.
create or replace function public.get_or_create_conversation(
  p_channel_id        uuid,
  p_external_user_id  text,
  p_contact_name      text default null
)
returns public.conversations
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_channel public.channels;
  v_conv    public.conversations;
begin
  select * into v_channel from public.channels where id = p_channel_id and status = 'active';
  if not found then
    raise exception 'channel_not_found';
  end if;

  insert into public.conversations as cv
    (tenant_id, channel_id, channel_type, external_user_id, contact_name)
  values
    (v_channel.tenant_id, v_channel.id, v_channel.type, p_external_user_id, p_contact_name)
  on conflict (channel_id, external_user_id)
  do update set contact_name = coalesce(excluded.contact_name, cv.contact_name)
  returning * into v_conv;

  return v_conv;
end;
$$;

-- Sa përgjigje AI ka konsumuar tenant-i këtë muaj kalendarik (UTC).
create or replace function public.ai_replies_this_month(p_tenant_id uuid)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::integer
  from public.usage_events
  where tenant_id = p_tenant_id
    and event_type = 'ai_reply'
    and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc';
$$;

revoke all on function public.match_chunks(uuid, extensions.vector, text, integer) from public, anon, authenticated;
revoke all on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.get_or_create_conversation(uuid, text, text) from public, anon, authenticated;
revoke all on function public.ai_replies_this_month(uuid) from public, anon, authenticated;

grant execute on function public.match_chunks(uuid, extensions.vector, text, integer) to service_role;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;
grant execute on function public.get_or_create_conversation(uuid, text, text) to service_role;
grant execute on function public.ai_replies_this_month(uuid) to service_role;
