# Website → Knowledge Base

Klienti vendos vetëm adresën e website-it (në panel ose në plugin-in WordPress). SupportBot
lexon faqet publike në sfond, ndërton dhe mban të përditësuar bazën e njohurive të tenant-it,
dhe chatbot-i përgjigjet prej saj me referenca te faqet burimore. FAQ manuale mbeten opsionale.

---

## 1. Auditimi i gjendjes fillestare (Faza A)

| Çfarë u kërkua | Çfarë u gjet realisht |
|---|---|
| `ai-smart-faq-chatbot.php` | **Nuk ekziston** në repo. Plugin-i real ishte `wp-plugin/supportbot-widget/supportbot-widget.php` (v0.1.0): vetëm fushë për `widget_key` + `<script>` në footer. Nuk kishte FAQ të para-përcaktuara as thirrje AI. Ai plugin u evolua (shih §7). |
| Konfigurime placeholder | `SUPPORTBOT_APP_URL = 'https://PROJEKTI.vercel.app'` i hardcode-uar në plugin. U zëvendësua me fushë cilësimi (ose konstante në `wp-config.php`). |
| Autentikim | `requireUser` (JWT i Supabase → `users.tenant_id`). Ruhet; u shtua `requireActor` që pranon edhe çelësa API `ak_…` (vetëm hash SHA-256 në DB). |
| Biseda, rate limiting, kuota | `handleInbound`, `check_rate_limit`, `usage_events` — të ripërdorura pa ndryshim logjike. |
| RAG ekzistues | `chunk → embed (Voyage 512d) → match_chunks (hibrid vektor + full-text, RRF) → Claude Haiku (tool `reply`)`. **I ripërdorur**; u shtuan URL, filtër relevance, referenca, neutralizim i përmbajtjes. |
| Crawler | Nuk ekzistonte. `kb/ingest` pranonte vetëm tekst të ngjitur. |
| Cache | Asnjë. U shtua cache i embedding-ut të pyetjes (shih §10). |
| Typecheck | `pnpm typecheck` dështonte që në fillim (TypeScript 6 pa `types: ["node"]`, importi i CSS). U rregullua. |

## 2. Arkitektura

```
 Paneli (Next.js)        Plugin WordPress (PHP, server-side)
   │ JWT i sesionit         │ Bearer ak_… (çelës API, scope 'kb')
   └──────────┬─────────────┘
              ▼
   /api/kb/sources  (+/verify, /sync, /retry)   /api/kb/documents   /api/kb/search
              │ krijon crawl_jobs (një aktiv për burim — indeks unik)
              ▼
   ┌──────────────── Worker (në sfond) ─────────────────┐
   │ /api/cron/crawl (Vercel Cron / pg_cron)  ose       │
   │ scripts/crawl-worker.ts (proces i dedikuar)        │
   │  claim_crawl_job → lease (skip locked)             │
   │  pending → crawling → indexing → ready | failed    │
   └────────────────────────────────────────────────────┘
      crawling: robots.txt → sitemap(-et) → radha (crawl_queue)
                safeFetch (SSRF) → ETag/Last-Modified → nxjerrje teksti
      indexing: boilerplate midis faqeve → chunks → embeddings vetëm për
                chunks të reja → documents/document_chunks → fshirje e faqeve
                të zhdukura (vetëm pas crawl-i të plotë dhe të shëndetshëm)
              ▼
   Vizitor → widget/Telegram → handleInbound → retrieve (match_chunks: vetëm
   tenant-i, vetëm burime/dokumente aktive) → filtër relevance → Claude →
   përgjigje + referenca URL → usage_events → Langfuse
```

**Pse jo Supabase Edge Functions për crawl-in:** një crawl mund të zgjasë minuta dhe bën
qindra kërkesa HTTP; Edge Functions kanë limite kohe/CPU të papërshtatshme. Crawl-i është
i ndarë në "tick"-e të kufizuara (default 45 s) që lënë gjithë gjendjen në Postgres, ndaj
mund të ekzekutohet nga një funksion Vercel i thirrur çdo minutë **ose** nga një proces
Node i dedikuar, pa ndryshuar kodin.

## 3. Skema (migrimi `20261013000000_website_knowledge.sql`)

| Tabela | Përmbajtja | RLS / grant për `authenticated` |
|---|---|---|
| `knowledge_sources` | website-i: `root_url`, `host`, `enabled`, verifikimi, `max_pages`, `max_depth`, `exclude_patterns`, `sync_interval_hours`, `next_sync_at`, statusi, `boilerplate` | `select` vetëm i tenant-it; asnjë shkrim direkt |
| `crawl_jobs` | një skanim: statusi, numëruesit, `truncated`/`incomplete`, retry/lease | `select` vetëm kolonat publike (jo `robots_txt`, `boilerplate`, lease) |
| `crawl_queue` | radha e URL-ve + teksti i nxjerrë përkohësisht | **asnjë akses** (vetëm serveri) |
| `crawl_job_events` | ngjarje monitorimi (kod, URL, mesazh pa sekrete) | `select` i tenant-it |
| `api_keys` | çelësat e plugin-it (vetëm `key_hash`) | `select` pa `key_hash` |
| `documents` (+) | `source_id`, `url`, `enabled`, `language`, `description`, `etag`, `last_modified`, `published_at`, `modified_at`, `last_seen_job_id`, `indexed_at` | si më parë |
| `document_chunks` (+) | `content_hash` (për ripërdorimin e embeddings) | si më parë |
| `tenants` (+) | `max_sources`, `max_crawl_pages`, `max_kb_chunks`, `min_sync_interval_hours` | tenant-i **nuk** i ndryshon (grant-i i update mbetet për 3 kolona) |

RPC (vetëm `service_role`): `match_chunks` (tani me `document_url`, `fts_match`, filtër
`enabled`), `claim_crawl_job`, `claim_crawl_urls`, `crawl_boilerplate`, `enqueue_due_syncs`.

Fshirja e burimit fshin me cascade dokumentet, chunks, job-et, radhën dhe ngjarjet; fshirja e
tenant-it fshin gjithçka të tij.

## 4. Crawler-i

- **URL të pranuara:** vetëm `http`/`https`, portet `CRAWLER_ALLOWED_PORTS` (80, 443), pa
  `user:pass@`. Host-i dhe varianti `www.` — asnjë subdomain tjetër, asnjë host i huaj.
- **Zbulimi:** `robots.txt` (RFC 9309: grupi më specifik, rruga më e gjatë, Allow në barazim,
  `*` dhe `$`, Crawl-delay) → `Sitemap:` e tij ose `/sitemap.xml`, `/sitemap_index.xml`,
  `/wp-sitemap.xml` (indekse të futura, `.xml.gz`) → lidhjet e brendshme deri në `max_depth`.
- **Normalizimi:** pa fragment, pa port default, pa `utm_*`/`fbclid`/`gclid`/sesione/`ref`,
  parametrat të renditur, pa `index.html`, max 5 parametra, max 2000 karaktere. Skedarët
  jo-HTML (PDF, imazhe, CSS…) anashkalohen. Përjashtime default: wp-admin, login, cart,
  checkout, feed, kërkimi; plus `exclude_patterns` të administratorit (prefiks, `*`, `$`).
- **Nxjerrja:** titulli, `meta description`, canonical, `lang`, datat (`article:*`, `<time>`),
  vetëm `<main>/<article>` kur ekzistojnë; hiqen skriptet, stilet, `nav/header/footer/aside/form`,
  rolet ARIA të navigimit, klasat e menuve/cookie/reklamave, **elementet e fshehura**
  (`hidden`, `aria-hidden`, `display:none`…). Paragrafët që përsëriten në ≥ 50% të faqeve
  (menu, slogan, footer brenda `<main>`) hiqen si boilerplate.
- **Respekti:** `robots.txt`, `noindex`/`nofollow` (meta dhe `X-Robots-Tag`), `rel=nofollow`,
  pauzë midis kërkesave (`CRAWLER_MIN_DELAY_MS`, Crawl-delay deri `CRAWLER_MAX_DELAY_MS`),
  `429/503` + `Retry-After`. Faqet `401/403` anashkalohen: **asnjë cookie, asnjë kredencial,
  asnjë anashkalim paywall-i.**
- **Gabimet:** timeout/rrjet/5xx → riprovim me backoff (`CRAWLER_RETRY_BASE_MS`·2ⁿ, deri
  `CRAWLER_MAX_ATTEMPTS`); 404/410 → faqja hiqet; job-i që dështon pa pritur → backoff
  2/4/8/16 min, pas 5 provash `failed`. Lease-i i një worker-i të vdekur skadon dhe job-i
  vazhdon nga një tjetër. Asnjë job nuk zgjat > 6 orë.

## 5. Indeksimi dhe sinkronizimi

1. Teksti i pastruar (pa boilerplate) → `sha256`. I njëjtë me dokumentin ekzistues → vetëm
   metadata, **zero embeddings**.
2. Përndryshe: `chunkText` (`KB_CHUNK_MAX_CHARS`, `KB_CHUNK_OVERLAP_CHARS`) → çdo chunk me
   hash; chunks me hash të njohur **ripërdorin embedding-un** e vjetër; vetëm të rejat i
   dërgohen Voyage. Chunks e reja futen para se të fshihen të vjetrat (dokumenti mbetet i
   kërkueshëm gjatë rindeksimit).
3. Kërkesat e kushtëzuara (`If-None-Match`, `If-Modified-Since`) → `304` = e pandryshuar pa
   shkarkim.
4. Faqet që nuk u panë fshihen **vetëm** kur crawl-i ishte i plotë (`truncated=false`,
   `incomplete=false`) dhe i shëndetshëm (< 50% dështime). Një site i rënë përkohësisht nuk
   e zbraz KB-në.
5. Riskanimi periodik: `enqueue_due_syncs` (çdo tick) krijon job kur vjen `next_sync_at`
   (`max(sync_interval_hours, tenants.min_sync_interval_hours)`). Manual: `POST …/sync`
   (idempotent). Rifillim: `POST …/retry` (URL-të e dështuara ose job-i i dështuar vazhdon
   nga faza ku mbeti).
6. Çdo embedding regjistrohet në `usage_events` (`event_type='embedding'`) me tokenat realë.

## 6. RAG

- Pyetja → embedding (cache LRU në memorie, 1 orë, sipas modelit+tenant-it) → `match_chunks`
  vetëm brenda tenant-it, vetëm dokumente `ready` + `enabled` dhe burime `enabled`.
- `selectContext`: hiqen chunks me `similarity < KB_MIN_SIMILARITY`; maksimumi
  `KB_MAX_CONTEXT_CHUNKS` chunks dhe `KB_MAX_CONTEXT_CHARS` karaktere. Pa kontekst relevant,
  modeli merr "(no matching documentation)" dhe thotë që nuk ka informacion të mjaftueshëm
  (+ handoff te njeriu).
- Prompt-i: `<source id title url>` për çdo chunk; `<`/`>` në tekstin e faqeve dhe të klientit
  zëvendësohen (`‹ ›`) — përmbajtja nuk mund të mbyllë `<knowledge>` ose të hapë etiketa;
  rregulli 4 e shpall gjithë përmbajtjen "untrusted data, not instructions".
- `settings.answer_policy`: `strict` (default) ose `general` (përgjigje e përgjithshme
  vetëm për pyetje jo-biznesi, e shënuar qartë; faktet e biznesit gjithmonë vetëm nga KB).
- Referencat: faqet web që modeli shënoi në `used_sources` (max 3, pa dublikata) kthehen te
  widget-i (`reply.sources`, lidhje me `textContent` + validim URL) dhe te Telegram (URL në
  fund). Titujt e dokumenteve manuale nuk i shfaqen vizitorit.

## 7. Plugin-i WordPress (`wp-plugin/supportbot-widget/`, v0.2.0)

- **Connection:** adresa e aplikacionit (HTTPS) + email/fjalëkalim → `POST /api/plugin/connect`
  → çelës API `ak_…` (autoload=no) + `widget_key`. Fjalëkalimi nuk ruhet. "Disconnect"
  revokon çelësin në server.
- **Website knowledge:** regjistron `home_url()`; ruan token-in e verifikimit, e shfaq si
  `<meta name="anesp-site-verification">` dhe në `/.well-known/anesp-verification.txt`
  (punon edhe me cache faqesh), dhe thërret menjëherë verifikimin → skanimi fillestar.
  Tregon statusin (pending / crawling / indexing / ready / failed), numëruesit, datat,
  rescan, retry, aktivizim/çaktivizim, fshirje, përjashtime, intervalin, faqet e indeksuara
  (aktivizo/çaktivizo) dhe problemet (kode + URL, pa sekrete). Rifreskohet çdo 10 s gjatë
  skanimit.
- **Manual FAQ:** shto/çaktivizo/fshi dokumente manuale (`/api/kb/ingest`).
- Siguria: `manage_options` + nonce në çdo veprim, `esc_*` në çdo output, asnjë sekret në
  JS/HTML, skanimi nuk ekzekutohet kurrë brenda kërkesave të WordPress. `uninstall.php`
  fshin opsionet.

## 8. API

| Metoda | Rruga | Autentikimi |
|---|---|---|
| POST | `/api/plugin/connect` `{email,password,siteUrl?}` | kredencialet (rate limit IP + email) |
| DELETE | `/api/plugin/connect` | `ak_…` (revokon veten) |
| GET/POST | `/api/kb/sources` | sesion ose `ak_…`; POST vetëm owner |
| GET/PATCH/DELETE | `/api/kb/sources/<id>` | po ashtu |
| POST | `/api/kb/sources/<id>/verify` · `/sync` · `/retry` | owner |
| GET | `/api/kb/documents?source_id=<uuid\|manual>` | sesion ose `ak_…` |
| PATCH/DELETE | `/api/kb/documents/<id>` | owner |
| POST | `/api/kb/search` `{query}` | sesion ose `ak_…` |
| POST | `/api/kb/ingest` | sesion ose `ak_…` (owner) |
| DELETE | `/api/keys/<id>` | sesion i pronarit |
| GET/POST | `/api/cron/crawl` | `Bearer CRON_SECRET` (≥ 16 karaktere; pa të rruga është e mbyllur) |

Gabimet kthehen si `{ error: '<kod>' }` (p.sh. `url_not_allowed`, `verification_failed`,
`source_limit_reached`, `job_active`, `plan_inactive`, `rate_limited`).

## 9. Siguria

| Rrezik | Kontrolli |
|---|---|
| SSRF | `checkTarget` në **çdo** hop: refuzon IPv4/IPv6 private, loopback, link-local (169.254.169.254), CGNAT, multicast, dokumentim, NAT64/6to4/Teredo, `::ffff:`-mapped, emra lokalë/pa pikë, porte jo të lejuara. Nëse DNS kthen **edhe një** adresë të ndaluar → refuzim. |
| DNS rebinding | Lidhja hapet me adresën e verifikuar (`lookup` i ngulur), jo me një zgjidhje të dytë. |
| Ridrejtime | Ndiqen manualisht (max 5), secila e verifikuar; jashtë site-it → anashkalim. |
| Madhësi/kohë | `CRAWLER_MAX_BYTES` (edhe pas dekompresimit — kundër zip bomb), `CRAWLER_TIMEOUT_MS`, kufij sitemap, max 2000 elemente lidhjesh, ReDoS i testuar. |
| Abuzim i crawl-it | Verifikim pronësie (meta/skedar), `max_sources`, `max_crawl_pages`, `max_kb_chunks`, rate limit për sync/verify/krijim, vetëm një job aktiv për burim. |
| Multi-tenant | `tenant_id` vetëm nga JWT ose rreshti i çelësit API; çdo query `admin()` me `.eq('tenant_id', …)`; RLS + grant-e kolonash; teste RLS + e2e. |
| Sekrete | Çelësat API vetëm si hash; `crawl_queue` dhe hash-et e paarritshme nga klienti; ngjarjet pa body/sekrete; `CRAWLER_DEV_HOST_MAP` injorohet në production. |
| Prompt injection | Elementet e fshehura nuk indeksohen; përmbajtja neutralizohet dhe shpallet "untrusted data". (Asnjë filtër nuk e garanton 100% sjelljen e modelit — provoje në Langfuse.) |
| XSS | Widget-i vetëm `textContent`; URL-të e referencave vetëm `http(s)`; plugin-i `esc_*`. |
| robots.txt | Respektohet, por **nuk** konsiderohet kontroll sigurie. |

## 10. Kostot

- Embeddings vetëm për chunks të reja/ndryshuara (hash), `304` pa shkarkim, faqet e
  pandryshuara pa embeddings — e2e e mat: një riskanim me 1 paragraf të ndryshuar dërgon 2
  chunks te Voyage dhe ripërdor 2.
- Cache i embedding-ut të pyetjes (pyetjet e përsëritura nuk thërrasin Voyage). Përgjigjet e
  AI **nuk** ruhen në cache: varen nga historiku dhe nga KB.
- Kontekst i kufizuar (6 chunks / 8000 karaktere) dhe filtër relevance para Claude.
- Ledger-i `usage_events` regjistron edhe embeddings e crawl-it; Langfuse merr metadata
  (`chunks_dropped_low_relevance`, `query_embedding_cached`, `citations`).
- Kufij plani në `tenants` (ndryshohen vetëm nga serveri / SQL).

## 11. Variablat e mjedisit (të reja)

| Variabla | Default | Shënim |
|---|---|---|
| `CRON_SECRET` | — | **E detyrueshme** nëse përdor `/api/cron/crawl` (`openssl rand -hex 32`). |
| `EMBEDDING_PROVIDER` | `voyage` | Shtresa e ofruesve: `src/lib/rag/embed.ts`. |
| `KB_CHUNK_MAX_CHARS` / `KB_CHUNK_OVERLAP_CHARS` | 1200 / 150 | |
| `KB_MIN_SIMILARITY` | 0.25 | Kalibroje me `top_similarity` në Langfuse. |
| `KB_MAX_CONTEXT_CHUNKS` / `KB_MAX_CONTEXT_CHARS` | 6 / 8000 | |
| `CRAWLER_TICK_BUDGET_MS` | 45000 | Për `/api/cron/crawl` (max 55000). |
| `CRAWLER_TIMEOUT_MS`, `CRAWLER_MAX_BYTES`, `CRAWLER_MAX_REDIRECTS` | 15000, 2000000, 5 | |
| `CRAWLER_MIN_DELAY_MS`, `CRAWLER_MAX_DELAY_MS` | 500, 10000 | Mirësjellje ndaj serverit të klientit. |
| `CRAWLER_MAX_ATTEMPTS`, `CRAWLER_RETRY_BASE_MS` | 3, 30000 | |
| `CRAWLER_MAX_SITEMAPS`, `CRAWLER_MAX_PAGE_CHARS` | 10, 100000 | |
| `CRAWLER_ALLOWED_PORTS` | `80,443` | |
| `CRAWLER_REQUIRE_VERIFICATION` | `true` | `false` vetëm për instalime private. |
| `CRAWLER_USER_AGENT`, `CRAWLER_ROBOTS_AGENT` | `…ANESPBot/1.0…`, `ANESPBot` | |
| `CRAWLER_WORKER_BUDGET_MS`, `CRAWLER_WORKER_IDLE_MS` | 120000, 15000 | Vetëm `scripts/crawl-worker.ts`. |
| `CRAWLER_DEV_HOST_MAP` | — | **Vetëm teste.** Injorohet kur `NODE_ENV=production`. |

## 12. Deploy

1. **Migrimi:** `bash scripts/migrate.sh` (aplikon `20261013000000_website_knowledge.sql`).
   Pastaj kontrollo: `psql "$DATABASE_URL" -f supabase/tests/rls_isolation.sql` → `TË GJITHA TESTET KALUAN`
   (bëhet ROLLBACK, nuk lë të dhëna).
2. **Vercel:** shto `CRON_SECRET` (dhe sipas nevojës `KB_*`, `CRAWLER_*`). Redeploy.
3. **Worker-i** — zgjidh një:
   - **Supabase pg_cron + pg_net (funksionon në planin falas):** ruaj sekretin në Vault dhe
     planifiko thirrjen çdo minutë (SQL Editor; jo migrim, sepse përmban adresën tënde):
     ```sql
     select vault.create_secret('<CRON_SECRET>', 'cron_secret');
     select cron.schedule('supportbot-crawl', '* * * * *', $$
       select net.http_post(
         url := 'https://<APP_URL>/api/cron/crawl',
         headers := jsonb_build_object('Authorization', 'Bearer ' ||
           (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
         timeout_milliseconds := 60000);
     $$);
     ```
   - **Vercel Cron** (plani Pro; Hobby lejon vetëm një herë në ditë): shto te `vercel.json`
     `{"crons":[{"path":"/api/cron/crawl","schedule":"* * * * *"}]}` — Vercel dërgon
     `Authorization: Bearer $CRON_SECRET` vetë.
   - **Proces i dedikuar** (site-e të mëdha, pa limitin 60 s): `pnpm worker` (ose
     `node --env-file=.env.local scripts/crawl-worker.ts`) në VPS/Railway/Fly/Render. Disa
     instanca mund të punojnë paralelisht (lease në DB).
4. **WordPress:** zip-o `wp-plugin/supportbot-widget/`, instaloje, Settings → SupportBot →
   vendos adresën e aplikacionit (ose `define('SUPPORTBOT_APP_URL', 'https://…');` në
   `wp-config.php`) → Connect → Website knowledge → "Register and start scanning".
5. **Provë:** `bash scripts/smoke.sh EMAIL FJALEKALIM`, pastaj shto website-in nga paneli dhe
   ndiq statusin te Knowledge.

## 13. Mirëmbajtja

- Job-e të ngecura: `select id, status, attempts, error, lease_until from crawl_jobs where status in ('pending','crawling','indexing') order by created_at;`
  Një lease i skaduar rimerret vetë; `POST /api/kb/sources/<id>/retry` rifillon një job të dështuar.
- Ngjarjet: `crawl_job_events` (kodet: `seeded`, `crawl_done`, `finished`, `timeout`, `http_5xx`, `forbidden_address`, `access_denied`, `kb_limit_reached`, `deletions_skipped`, `no_pages_indexed`…).
- Kufijtë e një klienti: `update tenants set max_crawl_pages = 500, max_kb_chunks = 10000 where id = '…';`
- Ndryshimi i modelit të embeddings kërkon ri-indeksim të plotë: `update documents set content_hash = 'reindex-' || id where source_id is not null; update document_chunks set content_hash = null;`, pastaj sync për çdo burim dhe rishtimi i dokumenteve manuale. Ndryshimi i dimensionit kërkon edhe migrim të kolonës `vector(512)`.
- Pastrimi: radha fshihet në fund të çdo job-i (mbeten vetëm URL-të e dështuara); `crawl_job_events` rritet me kohën — fshi të vjetrat periodikisht nëse duhet.

## 14. Testet (të ekzekutuara realisht)

| Komanda | Çfarë mbulon |
|---|---|
| `pnpm test` (43) | normalizimi i URL-ve, përjashtimet, robots.txt, sitemap (index, CDATA, namespace), nxjerrja HTML (menu/footer/fshehura/injection), gjuha, SSRF (IPv4/IPv6/mapped/NAT64, DNS, ridrejtim te metadata, zip bomb, timeout), ReDoS, relevanca, referencat, neutralizimi i prompt-it, politika e përgjigjes |
| `pnpm test:db` | migrimi + RLS për çdo tabelë të re, kolonat e mbrojtura, RPC (lease, skip locked, idempotenca e `enqueue_due_syncs`, boilerplate), cascade |
| `pnpm test:e2e` (54) | rrjedha e plotë: plugin connect → regjistrim → verifikim → crawl me sitemap dhe pa sitemap → thellësi/cikle/max_pages → 304/hash/ripërdorim embeddings → faqe e fshirë/e re → pyetje me dhe pa përgjigje → referenca → prompt injection → izolim A/B → retry pas rënies së site-it → lease i skaduar → kufij plani/rate limit → fshirje burimi → revokim çelësi; **plugin-i WordPress me PHP real** (stub-e WP + `php -S`) |

## 15. Kufizimet e njohura dhe hapat e ardhshëm

- Faqet që ndërtojnë përmbajtjen vetëm me JavaScript (SPA pa SSR) dalin bosh: nuk ka
  rendering me browser headless (i qëllimshëm: kosto dhe sipërfaqe sulmi).
- PDF dhe dokumente të lidhura nuk lexohen ende (anashkalohen si jo-HTML).
- Boilerplate-i llogaritet vetëm kur crawl-i merr ≥ 4 faqe; site-et shumë të vegjël mund të
  mbajnë menu të përsëritura brenda `<main>`.
- `KB_MIN_SIMILARITY` është kalibruar në teori; duhet rregulluar me trafik real (Langfuse).
- Teksti i nxjerrë rri përkohësisht në `crawl_queue` (≤ `CRAWLER_MAX_PAGE_CHARS` për faqe);
  për plane me mijëra faqe, monitoro madhësinë e DB-së.
- Crawl-i i një site-i është sekuencial (një kërkesë në kohë); site-e shumë të mëdha kërkojnë
  worker-in e dedikuar.
- Fshirja e llogarisë nga Supabase Auth fshin profilin, por jo tenant-in (sjellje e
  mëparshme e MVP-së); fshirja e tenant-it bëhet me SQL dhe fshin gjithçka me cascade.
- Plugin-i WordPress është testuar me stub-e të API-ve të WP, jo në një instalim të plotë
  WordPress — provoje në një site staging para publikimit.
- Asnjë deploy real nuk është bërë nga ky ndryshim: migrimi, env-i dhe cron-i duhen
  aplikuar sipas §12.
