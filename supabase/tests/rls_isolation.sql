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
  v_kb uuid; v_ch uuid; v_doc uuid; v_conv public.conversations; v_msg bigint; t uuid;
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
  assert n = 3, 'match_chunks: pyetje pa fjalë duhet të kthejë rezultatet semantike';

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
                             'documents','document_chunks','usage_events'] loop
    execute format('select count(*) from public.%I where tenant_id <> $1', tbl) into n using ids.tenant_a;
    assert n = 0, format('RLS: %s tregon rreshta të tenant-it tjetër', tbl);
    execute format('select count(*) from public.%I', tbl) into n;
    assert n > 0, format('RLS: %s nuk tregon rreshtat e vet', tbl);
  end loop;

  select count(*) into n from public.tenants;
  assert n = 1, 'RLS: tenants duhet të tregojë saktësisht 1 rresht';
  select count(*) into n from public.document_chunks;
  assert n = 3, 'RLS: document_chunks duhet të tregojë 3 chunks të vetat';

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
  delete from public.documents where tenant_id = ids.tenant_a;
  get diagnostics n = row_count;
  assert n = 1, 'documents: fshirja e dokumentit të vet';
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
                             'knowledge_bases','documents','document_chunks','usage_events','rate_limits'] loop
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
  assert (select count(*) from public.document_chunks where tenant_id = ids.tenant_b) = 3, 'chunks të B u prekën';
  assert (select count(*) from public.documents where tenant_id = ids.tenant_b) = 1, 'dokumenti i B u prek';
end $$;

select 'TË GJITHA TESTET KALUAN' as rezultati;

rollback;
