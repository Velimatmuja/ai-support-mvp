-- =============================================================================
-- Test i izolimit të tenant-ëve + i funksioneve RPC.
-- Ekzekutoje në Supabase SQL Editor (ose: psql "$DATABASE_URL" -f ky_skedar).
-- Gjithçka bëhet brenda një transaksioni dhe në fund bëhet ROLLBACK:
-- nuk lë asnjë të dhënë pas. Nëse një kontroll dështon, skripti ndalon me gabim.
-- Suksesi: rreshti i fundit kthen 'TË GJITHA TESTET KALUAN'.
-- =============================================================================
begin;

-- Dy "regjistrime": trigger-i duhet të krijojë tenant + profil + KB + kanal widget.
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a@test.local', '{"business_name":"Biznesi A"}'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b@test.local', '{}');

-- Vektor 512-dimensional me 1 në pozicionin p_pos (vektorë ortogonalë për test).
create function pg_temp.unit_vec(p_pos integer) returns text language sql as $$
  select '[' || string_agg(case when i = p_pos then '1' else '0' end, ',' order by i) || ']'
  from generate_series(1, 512) i;
$$;

create temp table t_ids on commit drop as
select
  (select tenant_id from public.users where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') as tenant_a,
  (select tenant_id from public.users where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') as tenant_b;
grant select on t_ids to public;

do $$
declare
  ids record;
  v_kb uuid; v_ch uuid; v_doc uuid; v_conv public.conversations; v_msg bigint; t uuid; v_src uuid; v_job uuid;
begin
  select * into ids from t_ids;
  assert ids.tenant_a is not null and ids.tenant_b is not null, 'trigger: tenant nuk u krijua';
  assert ids.tenant_a <> ids.tenant_b, 'trigger: dy përdorues ndajnë tenant';
  assert (select name from public.tenants where id = ids.tenant_a) = 'Biznesi A', 'trigger: emri nga metadata';
  assert (select name from public.tenants where id = ids.tenant_b) = 'b', 'trigger: emri nga email';
  assert (select count(*) from public.channels where type = 'widget'
          and tenant_id in (ids.tenant_a, ids.tenant_b)) = 2, 'trigger: kanali widget';
  assert (select count(*) from public.knowledge_bases
          where tenant_id in (ids.tenant_a, ids.tenant_b)) = 2, 'trigger: knowledge base';

  -- Të dhëna për të dy tenant-ët (si serveri).
  foreach t in array array[ids.tenant_a, ids.tenant_b] loop
    select id into v_kb from public.knowledge_bases where tenant_id = t;
    select id into v_ch from public.channels where tenant_id = t and type = 'widget';

    insert into public.documents (tenant_id, knowledge_base_id, title, status, content_hash)
    values (t, v_kb, 'Dok ' || t, 'ready', 'hash-' || t) returning id into v_doc;

    insert into public.document_chunks (tenant_id, knowledge_base_id, document_id, chunk_index, content, embedding)
    values
      (t, v_kb, v_doc, 0, 'Orari i punës: e hënë deri e premte 09:00-17:00', pg_temp.unit_vec(1)::extensions.vector),
      (t, v_kb, v_doc, 1, 'Dërgesa falas për porosi mbi 3000 lekë',           pg_temp.unit_vec(2)::extensions.vector),
      (t, v_kb, v_doc, 2, 'Kthimi i produktit brenda 14 ditësh',               pg_temp.unit_vec(3)::extensions.vector);

    v_conv := public.get_or_create_conversation(v_ch, 'visitor-1', null);
    assert v_conv.tenant_id = t, 'get_or_create_conversation: tenant gabim';

    insert into public.messages (tenant_id, conversation_id, role, content, external_id)
    values (t, v_conv.id, 'user', 'Përshëndetje', 'ext-1') returning id into v_msg;

    insert into public.usage_events (tenant_id, conversation_id, message_id, event_type, model, input_tokens, output_tokens)
    values (t, v_conv.id, v_msg, 'ai_reply', 'test', 10, 5);

    insert into public.channel_secrets (channel_id, tenant_id, bot_token_enc, webhook_secret)
    values (v_ch, t, 'TOKEN-SEKRET', 'WEBHOOK-SEKRET');

    -- Website -> KB: burim, faqe e indeksuar, job, radhë, ngjarje, çelës API.
    insert into public.knowledge_sources (tenant_id, knowledge_base_id, root_url, host, verified_at, next_sync_at)
    values (t, v_kb, 'https://site-' || t || '.example/', 'site-' || t || '.example', now(), now() - interval '1 minute')
    returning id into v_src;
    insert into public.documents (tenant_id, knowledge_base_id, title, source_type, status, content_hash, source_id, url)
    values (t, v_kb, 'Faqja web', 'web', 'ready', 'web-' || t, v_src, 'https://site-' || t || '.example/rreth')
    returning id into v_doc;
    insert into public.document_chunks (tenant_id, knowledge_base_id, document_id, chunk_index, content, embedding)
    values (t, v_kb, v_doc, 0, 'Rreth nesh: themeluar në 2010', pg_temp.unit_vec(10)::extensions.vector);
    insert into public.crawl_jobs (tenant_id, source_id, trigger, status, max_pages, max_depth, robots_txt, finished_at)
    values (t, v_src, 'initial', 'ready', 50, 2, 'User-agent: *', now()) returning id into v_job;
    insert into public.crawl_queue (tenant_id, job_id, url, status, extracted)
    values (t, v_job, 'https://site-' || t || '.example/x', 'failed', '{"text":"TEKST I PAPËRPUNUAR"}');
    insert into public.crawl_job_events (tenant_id, job_id, level, code) values (t, v_job, 'info', 'finished');
    insert into public.api_keys (tenant_id, name, prefix, key_hash)
    values (t, 'WordPress', 'ak_test', encode(sha256(t::text::bytea), 'hex'));
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 1) Funksionet RPC (si serveri)
-- -----------------------------------------------------------------------------
set local role service_role;

do $$
declare
  ids record; r record; n integer; v_ch uuid; c1 public.conversations; c2 public.conversations;
begin
  select * into ids from t_ids;

  -- match_chunks: vetëm chunks të tenant-it A, edhe pse B ka përmbajtje identike.
  select count(*) into n from public.match_chunks(ids.tenant_a, pg_temp.unit_vec(2)::extensions.vector, 'dërgesa', 6) m
    join public.document_chunks c on c.id = m.id where c.tenant_id <> ids.tenant_a;
  assert n = 0, 'match_chunks: rrjedhje midis tenant-ëve';

  select * into r from public.match_chunks(ids.tenant_a, pg_temp.unit_vec(2)::extensions.vector, 'dërgesa falas', 6) limit 1;
  assert r.content like 'Dërgesa falas%', 'match_chunks: renditja semantike+fts gabim: ' || coalesce(r.content, 'null');
  assert r.similarity > 0.99, 'match_chunks: similarity duhet ~1';
  assert r.document_title like 'Dok %', 'match_chunks: titulli i dokumentit';

  -- Vetëm full-text: vektori i pyetjes s'ngjan me asgjë, por fjala "kthimi" gjendet.
  select * into r from public.match_chunks(ids.tenant_a, pg_temp.unit_vec(400)::extensions.vector, 'si bëhet kthimi?', 6) limit 1;
  assert r.content like 'Kthimi%', 'match_chunks: full-text nuk e ngriti chunk-un e duhur';

  -- Pyetje bosh / vetëm pikësim: nuk duhet të hedhë gabim.
  select count(*) into n from public.match_chunks(ids.tenant_a, pg_temp.unit_vec(1)::extensions.vector, '???', 6);
  assert n = 4, 'match_chunks: pyetje pa fjalë duhet të kthejë rezultatet semantike';

  -- p_match_count respektohet.
  select count(*) into n from public.match_chunks(ids.tenant_a, pg_temp.unit_vec(1)::extensions.vector, 'orari', 2);
  assert n = 2, 'match_chunks: limit';

  -- Dokumentet jo "ready" nuk kthehen.
  update public.documents set status = 'processing' where tenant_id = ids.tenant_a;
  select count(*) into n from public.match_chunks(ids.tenant_a, pg_temp.unit_vec(1)::extensions.vector, 'orari', 6);
  assert n = 0, 'match_chunks: dokument jo-ready u kthye';
  update public.documents set status = 'ready' where tenant_id = ids.tenant_a;

  -- Rate limit: 3 lejohen, e 4-ta jo; bucket tjetër është i pavarur.
  assert public.check_rate_limit('test:x', 3, 3600), 'rate limit 1';
  assert public.check_rate_limit('test:x', 3, 3600), 'rate limit 2';
  assert public.check_rate_limit('test:x', 3, 3600), 'rate limit 3';
  assert not public.check_rate_limit('test:x', 3, 3600), 'rate limit: e 4-ta duhej bllokuar';
  assert public.check_rate_limit('test:y', 3, 3600), 'rate limit: bucket tjetër';

  -- get_or_create_conversation është idempotent.
  select id into v_ch from public.channels where tenant_id = ids.tenant_a and type = 'widget';
  c1 := public.get_or_create_conversation(v_ch, 'visitor-1', null);
  c2 := public.get_or_create_conversation(v_ch, 'visitor-1', 'Ana');
  assert c1.id = c2.id, 'conversation: duhej e njëjta bisedë';
  assert c2.contact_name = 'Ana', 'conversation: emri i kontaktit';
  c2 := public.get_or_create_conversation(v_ch, 'visitor-2', null);
  assert c1.id <> c2.id, 'conversation: vizitor tjetër duhet bisedë tjetër';
  begin
    perform public.get_or_create_conversation(gen_random_uuid(), 'x', null);
    raise exception 'conversation: kanal i paqenë duhej refuzuar';
  exception when others then
    if sqlerrm <> 'channel_not_found' then raise; end if;
  end;

  -- Idempotenca e mesazheve: i njëjti external_id në të njëjtën bisedë refuzohet.
  begin
    insert into public.messages (tenant_id, conversation_id, role, content, external_id)
    values (ids.tenant_a, c1.id, 'user', 'dublikatë', 'ext-1');
    raise exception 'messages: dublikata duhej refuzuar';
  exception when unique_violation then null;
  end;

  -- Kuota mujore.
  assert public.ai_replies_this_month(ids.tenant_a) = 1, 'ai_replies_this_month';
  insert into public.usage_events (tenant_id, event_type, created_at)
  values (ids.tenant_a, 'ai_reply', now() - interval '40 days');
  insert into public.usage_events (tenant_id, event_type) values (ids.tenant_a, 'embedding');
  assert public.ai_replies_this_month(ids.tenant_a) = 1, 'ai_replies_this_month: muaji i kaluar / embedding nuk numërohen';
end $$;

-- Website -> KB (si serveri)
do $$
declare
  ids record; r record; n integer; v_src uuid; v_job public.crawl_jobs; v_job2 public.crawl_jobs; v_bp text[];
begin
  select * into ids from t_ids;
  select id into v_src from public.knowledge_sources where tenant_id = ids.tenant_a;

  -- match_chunks kthen URL-në e faqes dhe respekton dokumentet/burimet e çaktivizuara.
  select * into r from public.match_chunks(ids.tenant_a, pg_temp.unit_vec(10)::extensions.vector, 'themeluar', 6) limit 1;
  assert r.document_url = 'https://site-' || ids.tenant_a || '.example/rreth', 'match_chunks: document_url';
  assert r.fts_match, 'match_chunks: fts_match';
  update public.documents set enabled = false where tenant_id = ids.tenant_a and source_id is not null;
  select count(*) into n from public.match_chunks(ids.tenant_a, pg_temp.unit_vec(10)::extensions.vector, 'themeluar', 6) m where m.document_url is not null;
  assert n = 0, 'match_chunks: dokument i çaktivizuar u kthye';
  update public.documents set enabled = true where tenant_id = ids.tenant_a;
  update public.knowledge_sources set enabled = false where id = v_src;
  select count(*) into n from public.match_chunks(ids.tenant_a, pg_temp.unit_vec(10)::extensions.vector, 'themeluar', 6) m where m.document_url is not null;
  assert n = 0, 'match_chunks: burim i çaktivizuar u kthye';
  select count(*) into n from public.match_chunks(ids.tenant_a, pg_temp.unit_vec(1)::extensions.vector, 'orari', 6);
  assert n = 3, 'match_chunks: dokumentet manuale mbeten kur burimi web çaktivizohet';
  update public.knowledge_sources set enabled = true where id = v_src;

  -- enqueue_due_syncs: krijon job vetëm për burimet që u ka ardhur koha; idempotent.
  n := public.enqueue_due_syncs(20);
  assert n = 2, 'enqueue_due_syncs: prita 2 job-e (një për tenant), mora ' || n;
  assert public.enqueue_due_syncs(20) = 0, 'enqueue_due_syncs: thirrja e dytë nuk duhet të krijojë asgjë';
  assert (select next_sync_at > now() + interval '1 hour' from public.knowledge_sources where id = v_src), 'next_sync_at u shty';
  -- Afati vjen sërish ndërsa job-i i mëparshëm është ende aktiv: asnjë job i dytë, asnjë gabim.
  update public.knowledge_sources set next_sync_at = now() - interval '1 minute' where id = v_src;
  assert public.enqueue_due_syncs(20) = 0, 'enqueue_due_syncs: job aktiv ekziston, nuk duhej i dyti';
  assert (select count(*) from public.crawl_jobs where source_id = v_src and status in ('pending','crawling','indexing')) = 1, 'enqueue_due_syncs: dyfishim';

  -- Një job aktiv për burim: i dyti refuzohet nga indeksi unik.
  begin
    insert into public.crawl_jobs (tenant_id, source_id, trigger, max_pages, max_depth) values (ids.tenant_a, v_src, 'manual', 10, 1);
    raise exception 'u lejuan dy job-e aktive për të njëjtin burim';
  exception when unique_violation then null;
  end;

  -- claim_crawl_job: lease ekskluziv; një worker i dytë merr job-in TJETËR, i treti asgjë.
  v_job := public.claim_crawl_job('w1', 60);
  assert v_job.id is not null and v_job.status = 'crawling' and v_job.locked_by = 'w1', 'claim_crawl_job: w1';
  v_job2 := public.claim_crawl_job('w2', 60);
  assert v_job2.id is not null and v_job2.id <> v_job.id, 'claim_crawl_job: w2 duhej job tjetër';
  assert (public.claim_crawl_job('w3', 60)).id is null, 'claim_crawl_job: w3 nuk duhej të merrte asgjë';
  -- Lease i skaduar (worker-i vdiq): job-i rimerret.
  update public.crawl_jobs set lease_until = now() - interval '1 second' where id = v_job.id;
  assert (public.claim_crawl_job('w3', 60)).id = v_job.id, 'claim_crawl_job: lease i skaduar duhej rimarrë';

  -- claim_crawl_urls: vetëm pending dhe me radhë sipas thellësisë; backoff respektohet.
  insert into public.crawl_queue (tenant_id, job_id, url, depth, status, next_attempt_at) values
    (v_job.tenant_id, v_job.id, 'https://x/2', 2, 'pending', now()),
    (v_job.tenant_id, v_job.id, 'https://x/0', 0, 'pending', now()),
    (v_job.tenant_id, v_job.id, 'https://x/later', 0, 'pending', now() + interval '1 hour'),
    (v_job.tenant_id, v_job.id, 'https://x/done', 0, 'indexed', now());
  assert (select string_agg(q.url, ',') from public.claim_crawl_urls(v_job.id, 10) q) = 'https://x/0,https://x/2', 'claim_crawl_urls: renditja/filtri';
  begin
    insert into public.crawl_queue (tenant_id, job_id, url) values (v_job.tenant_id, v_job.id, 'https://x/0');
    raise exception 'radha pranoi URL të dyfishtë';
  exception when unique_violation then null;
  end;

  -- crawl_boilerplate: paragrafi në >= 3 faqe është boilerplate.
  insert into public.crawl_queue (tenant_id, job_id, url, status, para_hashes) values
    (v_job.tenant_id, v_job.id, 'https://x/p1', 'fetched', '{menu,a}'),
    (v_job.tenant_id, v_job.id, 'https://x/p2', 'fetched', '{menu,b}'),
    (v_job.tenant_id, v_job.id, 'https://x/p3', 'fetched', '{menu,c,a}');
  v_bp := public.crawl_boilerplate(v_job.id, 3);
  assert v_bp = '{menu}', 'crawl_boilerplate: ' || v_bp::text;

  -- Fshirja e një burimi fshin gjithçka të lidhur (cascade), pa prekur të tjerat.
  insert into public.knowledge_sources (tenant_id, knowledge_base_id, root_url, host)
  select ids.tenant_a, kb.id, 'https://tjeter.example/', 'tjeter.example' from public.knowledge_bases kb where kb.tenant_id = ids.tenant_a
  returning id into v_src;
  insert into public.documents (tenant_id, knowledge_base_id, title, source_type, status, content_hash, source_id, url)
  select ids.tenant_a, kb.id, 'T', 'web', 'ready', 'h-tjeter', v_src, 'https://tjeter.example/' from public.knowledge_bases kb where kb.tenant_id = ids.tenant_a;
  insert into public.document_chunks (tenant_id, knowledge_base_id, document_id, chunk_index, content, embedding)
  select d.tenant_id, d.knowledge_base_id, d.id, 0, 'tjetër', pg_temp.unit_vec(20)::extensions.vector from public.documents d where d.source_id = v_src;
  insert into public.crawl_jobs (tenant_id, source_id, trigger, max_pages, max_depth) values (ids.tenant_a, v_src, 'initial', 5, 1)
  returning * into v_job2;
  insert into public.crawl_queue (tenant_id, job_id, url) values (ids.tenant_a, v_job2.id, 'https://tjeter.example/a');
  delete from public.knowledge_sources where id = v_src;
  assert not exists (select 1 from public.documents where source_id = v_src), 'cascade: documents';
  assert not exists (select 1 from public.crawl_jobs where source_id = v_src), 'cascade: crawl_jobs';
  assert not exists (select 1 from public.crawl_queue where job_id = v_job2.id), 'cascade: crawl_queue';
  assert (select count(*) from public.document_chunks where tenant_id = ids.tenant_a) = 4, 'cascade: chunks e burimeve të tjera mbetën';

  -- Dokumentet manuale mbeten unike sipas hash-it; faqet web unike sipas URL-së në burim.
  begin
    insert into public.documents (tenant_id, knowledge_base_id, title, content_hash)
    select ids.tenant_a, kb.id, 'dup', 'hash-' || ids.tenant_a from public.knowledge_bases kb where kb.tenant_id = ids.tenant_a;
    raise exception 'dokument manual i dyfishtë u pranua';
  exception when unique_violation then null;
  end;
  begin
    insert into public.documents (tenant_id, knowledge_base_id, title, source_type, content_hash)
    select ids.tenant_a, kb.id, 'web pa url', 'web', 'x' from public.knowledge_bases kb where kb.tenant_id = ids.tenant_a;
    raise exception 'dokument web pa burim/URL u pranua';
  exception when check_violation then null;
  end;
end $$;

reset role;

-- -----------------------------------------------------------------------------
-- 2) Përdoruesi A i loguar: sheh vetëm tenant-in A
-- -----------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}';
set local role authenticated;

do $$
declare
  ids record; n integer; tbl text;
begin
  select * into ids from t_ids;

  -- Çdo tabelë me tenant_id: asnjë rresht i tenant-it B nuk duket.
  foreach tbl in array array['users','channels','conversations','messages','knowledge_bases',
                             'documents','document_chunks','usage_events','knowledge_sources',
                             'crawl_jobs','crawl_job_events','api_keys'] loop
    execute format('select count(*) from public.%I where tenant_id <> $1', tbl) into n using ids.tenant_a;
    assert n = 0, format('RLS: %s tregon rreshta të tenant-it tjetër', tbl);
    execute format('select count(*) from public.%I', tbl) into n;
    assert n > 0, format('RLS: %s nuk tregon rreshtat e vet', tbl);
  end loop;

  select count(*) into n from public.tenants;
  assert n = 1, 'RLS: tenants duhet të tregojë saktësisht 1 rresht';
  select count(*) into n from public.document_chunks;
  assert n = 4, 'RLS: document_chunks duhet të tregojë 4 chunks të vetat';

  -- Sekretet dhe rate_limits: asnjë akses.
  begin
    perform 1 from public.channel_secrets;
    raise exception 'channel_secrets është i lexueshëm nga klienti!';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.rate_limits;
    raise exception 'rate_limits është i lexueshëm nga klienti!';
  exception when insufficient_privilege then null;
  end;

  -- Embeddings nuk shkarkohen nga klienti.
  begin
    perform embedding from public.document_chunks;
    raise exception 'kolona embedding është e lexueshme nga klienti!';
  exception when insufficient_privilege then null;
  end;

  -- Lejohet: ndryshimi i emrit / settings të tenant-it të vet.
  update public.tenants set name = 'Emër i ri', settings = '{"bot_name":"Asistenti"}' where id = ids.tenant_a;
  get diagnostics n = row_count;
  assert n = 1, 'tenants: update i vetes duhej të funksiononte';

  -- Nuk lejohet: ngritja e kuotës, zgjatja e provës, ndryshimi i planit/statusit.
  begin
    update public.tenants set monthly_ai_reply_limit = 999999 where id = ids.tenant_a;
    raise exception 'tenant-i mund të rrisë kuotën e vet!';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.tenants set trial_ends_at = now() + interval '10 years', plan = 'scale' where id = ids.tenant_a;
    raise exception 'tenant-i mund të ndryshojë planin/provën!';
  exception when insufficient_privilege then null;
  end;

  -- Tenant-i B: update/delete prek 0 rreshta.
  update public.tenants set name = 'hacked' where id = ids.tenant_b;
  get diagnostics n = row_count;
  assert n = 0, 'RLS: update i tenant-it tjetër kaloi!';
  delete from public.documents where tenant_id = ids.tenant_b;
  get diagnostics n = row_count;
  assert n = 0, 'RLS: delete i dokumenteve të tenant-it tjetër kaloi!';
  update public.conversations set status = 'closed' where tenant_id = ids.tenant_b;
  get diagnostics n = row_count;
  assert n = 0, 'RLS: update i bisedave të tenant-it tjetër kaloi!';

  -- Nuk lejohet: shkrimi direkt i mesazheve, dokumenteve, përdorimit, anëtarësisë.
  begin
    insert into public.messages (tenant_id, conversation_id, role, content)
    select tenant_id, id, 'assistant', 'fals' from public.conversations limit 1;
    raise exception 'klienti mund të shkruajë mesazhe direkt!';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.usage_events (tenant_id, event_type) values (ids.tenant_a, 'ai_reply');
    raise exception 'klienti mund të shkruajë në ledger!';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.usage_events where tenant_id = ids.tenant_a;
    raise exception 'klienti mund të fshijë nga ledger-i!';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.users set tenant_id = ids.tenant_b where id = (select auth.uid());
    raise exception 'klienti mund të kalojë te një tenant tjetër!';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.tenants (name) values ('tenant fals');
    raise exception 'klienti mund të krijojë tenant!';
  exception when insufficient_privilege then null;
  end;

  -- Nuk lejohet: thirrja e RPC-ve të serverit (do të lejonte kërkim në KB të tjetrit).
  begin
    perform public.match_chunks(ids.tenant_b, pg_temp.unit_vec(1)::extensions.vector, 'orari', 6);
    raise exception 'klienti mund të thërrasë match_chunks!';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_or_create_conversation(gen_random_uuid(), 'x', null);
    raise exception 'klienti mund të thërrasë get_or_create_conversation!';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.check_rate_limit('x', 1, 60);
    raise exception 'klienti mund të thërrasë check_rate_limit!';
  exception when insufficient_privilege then null;
  end;

  -- Lejohet: fshirja e dokumentit të vet; chunks fshihen me cascade.
  -- Website -> KB: paneli lexon burimet/job-et/ngjarjet e veta, por nuk shkruan asgjë direkt.
  begin
    perform 1 from public.crawl_queue;
    raise exception 'crawl_queue (tekst i papërpunuar) është i lexueshëm nga klienti!';
  exception when insufficient_privilege then null;
  end;
  begin
    perform key_hash from public.api_keys;
    raise exception 'api_keys.key_hash është i lexueshëm nga klienti!';
  exception when insufficient_privilege then null;
  end;
  begin
    perform robots_txt from public.crawl_jobs;
    raise exception 'crawl_jobs.robots_txt është i lexueshëm nga klienti!';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.knowledge_sources (tenant_id, knowledge_base_id, root_url, host)
    select tenant_id, id, 'https://evil.example/', 'evil.example' from public.knowledge_bases limit 1;
    raise exception 'klienti mund të krijojë burim direkt (anashkalon SSRF/verifikimin)!';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.knowledge_sources set verified_at = now();
    raise exception 'klienti mund të "verifikojë" vetë domain-in!';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.crawl_jobs (tenant_id, source_id, trigger, max_pages, max_depth)
    select tenant_id, id, 'manual', 999999, 10 from public.knowledge_sources limit 1;
    raise exception 'klienti mund të krijojë job crawl-i direkt!';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.api_keys (tenant_id, name, prefix, key_hash) values (ids.tenant_a, 'x', 'ak_x', repeat('0', 64));
    raise exception 'klienti mund të krijojë çelës API direkt!';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.tenants set max_crawl_pages = 100000, max_kb_chunks = 1000000 where id = ids.tenant_a;
    raise exception 'tenant-i mund të rrisë kufijtë e crawl-it!';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.claim_crawl_job('hacker', 60);
    raise exception 'klienti mund të thërrasë claim_crawl_job!';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.enqueue_due_syncs(1);
    raise exception 'klienti mund të thërrasë enqueue_due_syncs!';
  exception when insufficient_privilege then null;
  end;

  delete from public.documents where tenant_id = ids.tenant_a;
  get diagnostics n = row_count;
  assert n = 2, 'documents: fshirja e dokumenteve të veta';
  select count(*) into n from public.document_chunks;
  assert n = 0, 'documents: chunks duhej fshirë me cascade';
end $$;

reset role;

-- -----------------------------------------------------------------------------
-- 3) Vizitor anonim (çelësi publishable pa login): asgjë
-- -----------------------------------------------------------------------------
set local request.jwt.claims = '{"role":"anon"}';
set local role anon;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['tenants','users','channels','channel_secrets','conversations','messages',
                             'knowledge_bases','documents','document_chunks','usage_events','rate_limits',
                             'knowledge_sources','crawl_jobs','crawl_queue','crawl_job_events','api_keys'] loop
    begin
      execute format('select 1 from public.%I limit 1', tbl);
      raise exception 'anon mund të lexojë %', tbl;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform public.ai_replies_this_month(gen_random_uuid());
    raise exception 'anon mund të thërrasë RPC!';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- B nuk u prek nga asgjë që bëri A.
do $$
declare ids record;
begin
  select * into ids from t_ids;
  assert (select name from public.tenants where id = ids.tenant_b) = 'b', 'tenant B u modifikua';
  assert (select count(*) from public.document_chunks where tenant_id = ids.tenant_b) = 4, 'chunks të B u prekën';
  assert (select count(*) from public.documents where tenant_id = ids.tenant_b) = 2, 'dokumentet e B u prekën';
  assert (select count(*) from public.knowledge_sources where tenant_id = ids.tenant_b) = 1, 'burimi i B u prek';
  assert (select count(*) from public.api_keys where tenant_id = ids.tenant_b and revoked_at is null) = 1, 'çelësi i B u prek';
end $$;

select 'TË GJITHA TESTET KALUAN' as rezultati;

rollback;
