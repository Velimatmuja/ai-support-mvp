# SupportBot MVP — udhëzime për Claude Code

AI customer support SaaS, multi-tenant. Kanalet e MVP: web widget + Telegram.
Stack: Next.js App Router (Vercel) · Supabase (Postgres, Auth, RLS, pgvector) · Claude API · Voyage embeddings · Langfuse.
Zhvilluesi punon nga Android/Termux: pa Docker, pa Supabase CLI lokalisht.

## Komandat

- `pnpm test` — teste unit (Node, pa rrjet). Ekzekutoji pas çdo ndryshimi në `src/lib`.
- `pnpm test:db` — migrimi + testi i izolimit RLS në Postgres lokal të përkohshëm.
- `pnpm test:e2e` — rrjedha e plotë me PostgREST; ekzekutohet në GitHub Actions, jo në Termux.
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm worker` — worker-i i crawl-it si proces i dedikuar.
- `bash scripts/migrate.sh` — aplikon migrimet e reja në Supabase me psql.
- `bash scripts/smoke.sh EMAIL FJALEKALIM` — provë kundër deploy-it real.

## Rregulla që NUK thyhen

1. **tenant_id vjen vetëm nga burim i besuar**: `widget_key`, kanali + sekreti i webhook-ut, përdoruesi i verifikuar (`requireUser`), ose rreshti i çelësit API (`requireActor`, vetëm hash SHA-256 në DB). Kurrë nga body, query string ose `user_metadata`.
2. **`admin()` (çelësi secret, anashkalon RLS) importohet vetëm në kod serveri** dhe çdo query me të ka `.eq('tenant_id', ...)`. Asnjë variabël `NEXT_PUBLIC_*` nuk mban sekret.
3. **Paneli në browser** përdor vetëm çelësin publishable + sesionin e përdoruesit; mbrojtja e tij është RLS. Shkrimet e ndjeshme (mesazhe, dokumente, kanale) kalojnë nga API routes.
4. **Çdo tabelë e re**: kolona `tenant_id`, `enable row level security`, politika me `(select private.tenant_id())`, `revoke all ... from public, anon, authenticated` + grant-e minimale, dhe një rast i ri te `supabase/tests/rls_isolation.sql`.
5. **`usage_events` është burimi i së vërtetës për kuotat**. Vetëm INSERT, vetëm nga serveri, me tokenat që kthen API. Langfuse është vetëm vëzhgim.
6. **Çdo mesazh hyrës kalon nga `handleInbound`** (`src/lib/pipeline.ts`). Kanalet e reja vetëm zgjidhin tenant-in/bisedën dhe dërgojnë përgjigjen.
7. **Migrimet nuk editohen pasi janë aplikuar**: shto skedar të ri `supabase/migrations/<YYYYMMDDHHMMSS>_<emri>.sql`.
8. **Widget-i**: vetëm `textContent` për çdo tekst; asnjë sekret; asnjë varësi.
9. **Skedarët `page.tsx` / `layout.tsx` eksportojnë vetëm `default` dhe konfigurimet e Next** (`metadata`, `viewport`, `dynamic`…). Çdo gjë tjetër e përbashkët shkon te `src/lib/ui/`.
10. **Çdo tekst i panelit** shtohet te `src/lib/ui/strings.ts` në të dyja gjuhët; `t` nga `useStrings()` është e qëndrueshme dhe mund të përdoret si varësi në hooks.
11. **Çdo kërkesë HTTP drejt një URL-je të klientit** kalon nga `safeFetch` (`src/lib/crawl/netguard.ts`): asnjë `fetch` direkt. robots.txt respektohet, por nuk është kontroll sigurie. `CRAWLER_DEV_HOST_MAP` është vetëm për teste.
12. **Përmbajtja e faqeve të klientit është e dhënë e pabesueshme**: kalon nga `neutralize` në prompt dhe nuk ndryshon kurrë rregullat e sistemit.
13. **Crawl-i nuk ekzekutohet brenda një kërkese përdoruesi** (as WordPress): API vetëm krijon `crawl_jobs`; punën e bën worker-i (`runCrawlTick`) me lease.

## Konventa kodi

- Importe relative me prapashtesë `.ts` (`../env.ts`) dhe `import type` për tipet: testet ekzekutohen direkt me Node, pa bundler.
- Vetëm sintaksë TypeScript që fshihet (pa `enum`, pa parameter properties, pa namespaces).
- Shërbimet e jashtme thirren me `postJson` (`src/lib/http.ts`), jo me SDK.
- Gabimet për klientin: `throw new ApiError(status, 'kod')`; route-t mbarojnë me `errorResponse(e)`.
- Komentet shpjegojnë *pse*, në shqip.

## Struktura

- `supabase/migrations/` — skema, RLS, RPC (`match_chunks`, `check_rate_limit`, `get_or_create_conversation`, `ai_replies_this_month`).
- `src/lib/rag/` — `chunk` → `embed` → `retrieve` → `generate`; `ingest` për dokumentet.
- `src/lib/crawl/` — `netguard` (SSRF), `url`, `robots`, `sitemap`, `extract`, `discover`, `worker`; `src/lib/kb/` — burimet, dokumentet, `replaceChunks`. Shih `docs/WEBSITE-KB.md`.
- `src/lib/pipeline.ts` — rrjedha e një mesazhi: ruaj → handoff? → kuota → RAG → ledger → trace.
- `src/app/api/` — `widget/*`, `telegram/[channelId]`, `channels/telegram`, `kb/ingest`, `kb/sources/*`, `kb/documents/*`, `kb/search`, `plugin/connect`, `keys/[id]`, `cron/crawl`, `conversations/[id]/reply`.
- `src/app/login|signup|reset|privacy` — faqet publike; `src/app/app/*` — paneli (inbox, knowledge, settings), client components.
- `src/lib/supabase/browser.ts` — klienti i panelit (çelësi publishable); `src/lib/ui/` — `api.ts`, `app-context.ts`, `strings.ts` (en + sq).
- `src/app/globals.css` — i vetmi skedar stilesh; pa librari UI.
- `public/widget.js` — widget-i; `wp-plugin/` — plugin-i WordPress (testohet me `tests/wp/` + PHP real në e2e).
- `tests/unit`, `tests/e2e` (`website.ts`, `wordpress.ts`, `site.ts`), `tests/wp`, `supabase/tests`.

## Çfarë verifikohet me dorë (mos i beso verbërisht AI-së)

- Çdo politikë RLS dhe çdo `grant`: lexoje vetë dhe shto test që dështon pa të.
- Çdo përdorim i ri i `admin()`: a ka filtër `tenant_id`?
- Ndryshimet te system prompt (`buildSystemPrompt`): provoji me pyetje reale në Langfuse.
- Çmimet dhe emrat e modeleve: kontrollo faqen zyrtare para se t'i ndryshosh.
- `KB_MIN_SIMILARITY`: kalibroje me `top_similarity` dhe `chunks_dropped_low_relevance` në Langfuse.
- Plugin-i WordPress: provoje në një site staging (testet përdorin stub-e të WP).
