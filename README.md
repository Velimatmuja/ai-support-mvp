# SupportBot MVP

AI customer support multi-tenant për SMB: një biznes vendos adresën e website-it të vet (ose plugin-in
WordPress), SupportBot lexon faqet publike në sfond dhe ndërton bazën e njohurive; widget-i në faqe (ose një
bot Telegrami) u përgjigjet klientëve prej saj me referenca te faqet burimore. FAQ manuale janë opsionale.
Kur nuk di, ose kur klienti kërkon njeri, biseda kalon te një agjent.

**Website → Knowledge Base:** [`docs/WEBSITE-KB.md`](docs/WEBSITE-KB.md) — arkitektura, siguria, deploy i worker-it.

**Fillo këtu:** [`docs/7-DITE.md`](docs/7-DITE.md) — hapat ditë pas dite, me komanda për Termux.

## Si rrjedh një mesazh

```
 Vizitor (widget.js)          Telegram
        │ POST /api/widget/message   │ POST /api/telegram/<channelId> (+ sekret)
        ▼                            ▼
   widget_key → tenant         kanal → tenant
        └──────────────┬─────────────┘
                       ▼
              handleInbound (src/lib/pipeline.ts)
   1 ruaj mesazhin (idempotent)   2 biseda te njeriu? → AI hesht
   3 prova/kuota mujore → në limit: njoftim + handoff
   4 embedding i pyetjes (Voyage, cache) → match_chunks (vektor + full-text, vetëm tenant-i,
     vetëm burime aktive) → filtër relevance
   5 Claude Haiku → { answer, needs_human, used_sources } → referenca URL
   6 ruaj përgjigjen → usage_events (ledger) → handoff nëse duhet → trace në Langfuse
                       ▼
        përgjigje te widget-i / sendMessage te Telegram
```

## Struktura

| Rruga | Çfarë është |
|---|---|
| `supabase/migrations/` | Skema, RLS, funksionet RPC |
| `supabase/tests/rls_isolation.sql` | Testi i izolimit të tenant-ëve (ROLLBACK në fund) |
| `src/lib/rag/` | chunking, embeddings, retrieval, thirrja e Claude, ingest |
| `src/lib/crawl/` | crawler-i: SSRF (`netguard`), URL, robots.txt, sitemap, nxjerrja HTML, worker-i |
| `src/lib/kb/` | burimet (website), dokumentet, ruajtja e chunks me ripërdorim embeddings |
| `src/lib/pipeline.ts` | Rrjedha e vetme e çdo mesazhi hyrës |
| `src/app/api/` | Route handlers: widget, Telegram, knowledge base (`kb/sources`, `kb/documents`, `kb/search`, `kb/ingest`), `plugin/connect`, `cron/crawl`, përgjigja e agjentit |
| `src/app/app/` | Paneli: Inbox, Knowledge, Settings (pas hyrjes) |
| `src/app/login`, `signup`, `reset`, `privacy` | Faqet publike të panelit |
| `src/lib/ui/` | Ndihmës të panelit: thirrjet API, konteksti, tekstet en + sq |
| `public/widget.js` | Widget-i vanilla JS (Shadow DOM, pa varësi) |
| `wp-plugin/supportbot-widget/` | Plugin WordPress: widget + lidhja e llogarisë + website-i si KB + FAQ manuale |
| `scripts/` | `migrate.sh`, `smoke.sh`, `backup.sh`, `e2e.sh`, `local-db/run.sh`, `crawl-worker.ts` |
| `tests/` | Teste unit dhe end-to-end |
| `CLAUDE.md` | Rregullat e projektit për Claude Code |

## Komandat

```bash
pnpm install
pnpm test                 # unit
pnpm test:db              # RLS në Postgres lokal (kërkon paketën postgresql)
bash scripts/migrate.sh   # aplikon migrimet në Supabase (DATABASE_URL në .env.local)
pnpm worker               # worker-i i crawl-it si proces më vete (ose /api/cron/crawl çdo minutë)
bash scripts/smoke.sh EMAIL FJALEKALIM   # provë kundër deploy-it real
```

## Modeli i sigurisë, shkurt

- Browser-i i vizitorit njeh vetëm `widget_key` (publik) dhe një token të nënshkruar për bisedën e vet.
- Serveri përdor çelësin secret të Supabase dhe e nxjerr `tenant_id` vetëm nga burime të besuara.
- Paneli përdor çelësin publishable; çdo tabelë ka RLS të lidhur me tenant-in e përdoruesit.
- `usage_events` në Supabase është burimi i së vërtetës për kuotat; Langfuse shërben vetëm për vëzhgim.
- Plugin-i WordPress flet me API vetëm nga serveri, me një çelës `ak_…` (në DB ruhet vetëm hash-i, revokohet nga paneli).
- Crawler-i hap lidhje vetëm përmes `safeFetch` (SSRF: adresa private/metadata të bllokuara në çdo ridrejtim, DNS i ngulur).
