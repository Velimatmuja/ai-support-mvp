# SupportBot MVP

AI customer support multi-tenant për SMB: një biznes ngarkon FAQ-në e vet, vendos një widget në faqe (ose lidh
një bot Telegrami) dhe Claude u përgjigjet klientëve nga ajo përmbajtje. Kur nuk di, ose kur klienti kërkon
njeri, biseda kalon te një agjent.

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
   4 embedding i pyetjes (Voyage) → match_chunks (vektor + full-text, vetëm tenant-i)
   5 Claude Haiku → { answer, needs_human, used_sources }
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
| `src/lib/pipeline.ts` | Rrjedha e vetme e çdo mesazhi hyrës |
| `src/app/api/` | Route handlers: widget, Telegram, knowledge base, përgjigja e agjentit |
| `src/app/app/` | Paneli: Inbox, Knowledge, Settings (pas hyrjes) |
| `src/app/login`, `signup`, `reset`, `privacy` | Faqet publike të panelit |
| `src/lib/ui/` | Ndihmës të panelit: thirrjet API, konteksti, tekstet en + sq |
| `public/widget.js` | Widget-i vanilla JS (Shadow DOM, pa varësi) |
| `wp-plugin/supportbot-widget/` | Plugin WordPress që fut widget-in |
| `scripts/` | `migrate.sh`, `smoke.sh`, `backup.sh`, `e2e.sh`, `local-db/run.sh` |
| `tests/` | Teste unit dhe end-to-end |
| `CLAUDE.md` | Rregullat e projektit për Claude Code |

## Komandat

```bash
pnpm install
pnpm test                 # unit
pnpm test:db              # RLS në Postgres lokal (kërkon paketën postgresql)
bash scripts/migrate.sh   # aplikon migrimet në Supabase (DATABASE_URL në .env.local)
bash scripts/smoke.sh EMAIL FJALEKALIM   # provë kundër deploy-it real
```

## Modeli i sigurisë, shkurt

- Browser-i i vizitorit njeh vetëm `widget_key` (publik) dhe një token të nënshkruar për bisedën e vet.
- Serveri përdor çelësin secret të Supabase dhe e nxjerr `tenant_id` vetëm nga burime të besuara.
- Paneli përdor çelësin publishable; çdo tabelë ka RLS të lidhur me tenant-in e përdoruesit.
- `usage_events` në Supabase është burimi i së vërtetës për kuotat; Langfuse shërben vetëm për vëzhgim.
