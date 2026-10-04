# 7 ditët e para — nga Termux te piloti

Çdo ditë mbaron me diçka që punon dhe që mund ta provosh. Komandat janë për **Termux në Android**.
Vlerat me SHKRONJA TË MËDHA (`PROJEKTI`, `wk_...`) zëvendësohen me të tuat.

Fakte të kontrolluara më **2026-10-02**: Next.js 16.3.8, supabase-js 2.117.2, Termux `nodejs-lts` 24.18 /
`postgresql` 18.6 / `gh` 2.102, Claude Haiku 4.5 = $1 / $5 për 1M tokena, Voyage `voyage-4-lite` = $0.02 për 1M
tokena me 200M tokena falas.

---

## Gjendja më 2026-10-04

| Pjesa | Gjendja |
|---|---|
| Kodi (API, widget, Telegram, paneli, plugin WordPress) | I shkruar dhe i testuar lokalisht |
| **Supabase** — projekti `lwslmhlbplqyvjdyqvae` (Londër, Postgres 17, pgvector 0.8.2) | **Gati.** Skema e aplikuar; kontrollet e izolimit kaluan mbi databazën reale; asnjë e dhënë prove nuk mbeti |
| GitHub — `Velimatmuja/ai-support-mvp` | **Në pritje.** Repo-ja është ende publike; push bëhet pasi të bëhet private (ose me miratimin tënd për publike) |
| Vercel — ekipi `ANESP` | **Në pritje.** Lidhja e Claude me Vercel nuk ka leje të krijojë projekte: projekti krijohet nga ti te vercel.com/new (hapi 2.2) |
| Çelësat `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SUPABASE_SECRET_KEY` | I krijon dhe i vendos vetëm ti (hapat 2.1–2.2) |

Vlerat publike të Supabase për `.env.local` dhe Vercel (nuk janë sekrete):

```
NEXT_PUBLIC_SUPABASE_URL=https://lwslmhlbplqyvjdyqvae.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_TmCzaiHMKbgxoaehvAgvEA_kEnu8pH_
```

Rajoni i funksioneve në Vercel: **London (lhr1)**, i njëjti me databazën (Project Settings → Functions → Function Region).

Prandaj nga Dita 1 të mbeten vetëm 1.1–1.3 dhe krijimi i çelësit *secret* te Supabase; `bash scripts/migrate.sh` do të
tregojë `= 20261002000000_init.sql (e aplikuar më parë)`.

---

## Dita 1 — Mjedisi, repo, baza e të dhënave

### 1.1 Paketat në Termux

```bash
pkg update -y && pkg upgrade -y
pkg install -y git nodejs-lts postgresql openssl-tool jq unzip zip gh openssh nano
npm install -g pnpm
termux-setup-storage          # lejon leximin e dosjes Downloads
```

`postgresql` duhet për dy gjëra: `psql` (migrimet drejt Supabase) dhe një Postgres lokal për testin e RLS.
Docker **nuk** nevojitet askund.

### 1.2 Projekti

```bash
mkdir -p ~/code && cd ~/code
unzip ~/storage/downloads/supportbot-mvp.zip
cd supportbot-mvp
pnpm install
pnpm test          # 20 teste unit — pa rrjet, pa llogari
pnpm test:db       # migrimi + testi i izolimit RLS në një Postgres lokal të përkohshëm
```

Rreshti i fundit i `pnpm test:db` duhet të jetë `TË GJITHA TESTET KALUAN`.

### 1.3 Git + GitHub

```bash
git init -b main
git add -A
git commit -m "Fillimi: skema, RAG, widget, Telegram"
gh auth login                                   # GitHub.com → HTTPS → login me browser
gh repo create supportbot-mvp --private --source=. --push
```

### 1.4 Supabase

1. Në browser: <https://supabase.com/dashboard> → **New project** (rajoni më i afërt me klientët, p.sh. Frankfurt).
   Ruaje fjalëkalimin e databazës.
2. **Project Settings → API Keys**: kopjo *Project URL*, çelësin *publishable* (`sb_publishable_...`) dhe krijo
   një çelës *secret* (`sb_secret_...`). Çelësat e vjetër `anon` / `service_role` po hiqen brenda 2026 — mos i përdor.
3. Butoni **Connect** → *Session pooler* → kopjo connection string (punon me IPv4, pra edhe në rrjet celular).

```bash
cp .env.example .env.local
echo "WIDGET_TOKEN_SECRET=$(openssl rand -hex 32)"
echo "CHANNEL_ENCRYPTION_KEY=$(openssl rand -hex 32)"
nano .env.local        # ngjit URL-në, çelësat, DATABASE_URL dhe dy vlerat e mësipërme
```

```bash
bash scripts/migrate.sh
```

Duhet të shfaqet `+ 20261002000000_init.sql`. Tani testi i izolimit kundër Supabase-it real
(punon brenda një transaksioni dhe bën ROLLBACK — nuk lë asgjë pas):

```bash
set -a; . ./.env.local; set +a
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -t -f supabase/tests/rls_isolation.sql
```

Pritet `TË GJITHA TESTET KALUAN`. Ky është kontrolli i parë me pgvector real — nëse ndalon me gabim,
mos vazhdo: kopjo mesazhin te Claude Code dhe rregulloje para Ditës 2.

**Përfundimi i ditës:** repo në GitHub, skema në Supabase, izolimi i tenant-ëve i provuar.

---

## Dita 2 — Deploy në Vercel dhe përgjigjja e parë reale e AI

### 2.1 Çelësat e AI

- <https://console.anthropic.com> → API key. **Vendos një spend limit mujor** (p.sh. $20) te Settings → Limits:
  ky është tavani i fundit i kostos, pavarësisht çdo gabimi në kod.
- <https://dashboard.voyageai.com> → API key. Shto një metodë pagese: 200M tokenat falas vlejnë njësoj, por
  llogaritë pa metodë pagese kanë historikisht rate limit shumë të ulët (nuk e verifikova dot sot në dokumentacion).

### 2.2 Vercel

1. <https://vercel.com/new> → importo repo-n `supportbot-mvp` (framework: Next.js, pa ndryshime).
2. **Environment Variables** — shto të gjitha nga `.env.local` **përveç `DATABASE_URL`**:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY`,
   `ANTHROPIC_MODEL`, `VOYAGE_API_KEY`, `VOYAGE_MODEL`, `WIDGET_TOKEN_SECRET`, `CHANNEL_ENCRYPTION_KEY`, `APP_URL`.
3. Deploy. Pastaj vendos `APP_URL` = domeni i prodhimit (`https://PROJEKTI.vercel.app`) edhe te Vercel edhe te
   `.env.local`, dhe bëj **Redeploy**.

Përdor gjithmonë domenin e **prodhimit**: preview deployments mbrohen me login të Vercel dhe as widget-i,
as Telegram nuk i arrijnë dot.

### 2.3 Tenant-i i parë

Për provë, çaktivizo përkohësisht konfirmimin e email-it: Supabase → **Authentication → Sign In / Providers →
Email → Confirm email: OFF** (rikthehet në Ditën 7).

```bash
set -a; . ./.env.local; set +a
curl -sS "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/signup" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d '{"email":"TI@SHEMBULL.COM","password":"NjeFjalekalimIGjate-2026","data":{"business_name":"Biznesi Test"}}' \
  | jq '{email: (.user.email // .email)}'
```

Regjistrimi krijon automatikisht (me trigger në DB): tenant, profil pronari, knowledge base dhe kanalin widget.

```bash
bash scripts/smoke.sh TI@SHEMBULL.COM 'NjeFjalekalimIGjate-2026'
```

Skripti bën login, lexon `widget_key` përmes RLS, ngarkon një FAQ dhe bën një pyetje si vizitor.
Duhet të mbarojë me përgjigjen e Claude dhe `SMOKE TEST OK`. **Ruaje `wk_...` që printon.**

Nëse dështon: Vercel → projekti → **Logs** (plani Hobby i mban 1 orë).

**Përfundimi i ditës:** API live që përgjigjet nga knowledge base.

---

## Dita 3 — Widget-i në një faqe reale

### 3.1 Provë e menjëhershme

Hap në browser-in e telefonit: `https://PROJEKTI.vercel.app/demo.html?key=wk_...`

### 3.2 Personalizimi dhe kufizimi i origjinave

```bash
set -a; . ./.env.local; set +a
psql "$DATABASE_URL" <<'SQL'
update public.tenants
set allowed_origins = array['https://FAQJA-E-KLIENTIT.al', 'https://www.FAQJA-E-KLIENTIT.al'],
    settings = settings || '{"bot_name":"Ana","language":"sq","color":"#0f766e","welcome_message":"Përshëndetje! Si mund t’ju ndihmoj?"}'::jsonb
where widget_key = 'wk_...';
SQL
```

Me `allowed_origins` të vendosur, widget-i punon vetëm në ato faqe (edhe `demo.html` ndalon — shto
`https://PROJEKTI.vercel.app` në listë nëse do ta mbash për demo).

### 3.3 Në çdo faqe web

```html
<script src="https://PROJEKTI.vercel.app/widget.js" data-key="wk_..." async></script>
```

### 3.4 Në WordPress (plugin)

```bash
sed -i "s#https://PROJEKTI.vercel.app#https://DOMENI-YT.vercel.app#" wp-plugin/supportbot-widget/supportbot-widget.php
(cd wp-plugin && zip -r ~/storage/downloads/supportbot-widget.zip supportbot-widget)
```

WordPress → **Plugins → Add New → Upload Plugin** → aktivizo → **Settings → SupportBot** → ngjit `wk_...`.

### 3.5 Ngarko përmbajtje reale

```bash
TOKEN=$(curl -sS "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" -H 'content-type: application/json' \
  -d '{"email":"TI@SHEMBULL.COM","password":"NjeFjalekalimIGjate-2026"}' | jq -r .access_token)

jq -n --arg title "FAQ" --rawfile content ~/storage/downloads/faq.txt '{title: $title, content: $content}' \
  | curl -sS -X POST "$APP_URL/api/kb/ingest" -H "authorization: Bearer $TOKEN" \
      -H 'content-type: application/json' -d @- | jq
```

Bëj 10–15 pyetje reale dhe shiko ku gabon. Rregullo tekstin e FAQ, jo kodin: një paragraf për temë,
me fjalët që përdor klienti.

**Përfundimi i ditës:** widget-i live në një faqe WordPress me përmbajtje reale.

---

## Dita 4 — Telegram + kalimi te njeriu

1. Në Telegram: **@BotFather** → `/newbot` → emri → username → kopjo tokenin.
2. Lidhe me tenant-in (me `$TOKEN` nga hapi 3.5):

```bash
curl -sS -X POST "$APP_URL/api/channels/telegram" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"botToken":"123456789:AA..."}' | jq
```

3. Shkruaji bot-it një pyetje nga FAQ. Nëse nuk përgjigjet:

```bash
curl -sS "https://api.telegram.org/bot123456789:AA.../getWebhookInfo" | jq '.result | {url, pending_update_count, last_error_message}'
```

4. Provo handoff: shkruaj "dua të flas me një njeri". AI njofton klientin dhe hesht. Si agjent:

```bash
API="$NEXT_PUBLIC_SUPABASE_URL/rest/v1"; H=(-H "apikey: $NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" -H "authorization: Bearer $TOKEN")

# Inbox: bisedat e mia (RLS kthen vetëm ato të tenant-it tim)
curl -sS "$API/conversations?select=id,channel_type,status,contact_name,handoff_reason&order=last_message_at.desc&limit=10" "${H[@]}" | jq

# Përgjigju si njeri (shkon te Telegram ose te widget-i)
curl -sS -X POST "$APP_URL/api/conversations/ID-E-BISEDES/reply" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"text":"Përshëndetje, jam Ana nga ekipi."}' | jq

# Ktheja bisedën AI-së
curl -sS -X PATCH "$API/conversations?id=eq.ID-E-BISEDES" "${H[@]}" \
  -H 'content-type: application/json' -d '{"status":"open","ai_enabled":true}'
```

**Përfundimi i ditës:** dy kanale + handoff i plotë, i provuar me curl.

---

## Ditët 5–6 — Paneli (i ndërtuar)

Paneli është në repo. Gjithçka që më parë bëhej me `curl` (Ditët 2–4) tani bëhet edhe nga telefoni:

| Faqja | Çfarë bën |
|---|---|
| `/signup`, `/login`, `/reset` | Regjistrim (krijon tenant-in), hyrje, rivendosje fjalëkalimi |
| `/app/inbox` | Bisedat në tre grupe: *presin përgjigjen tënde*, *me asistentin*, *të mbyllura*. Përgjigje si agjent, ndalim i asistentit, kthim te asistenti, mbyllje |
| `/app/knowledge` | Shtim dokumenti me tekst, lista, fshirje |
| `/app/settings` | Përdorimi i muajit, kodi i widget-it, faqet e lejuara, emri/ngjyra/gjuha/toni i asistentit, lidhja e Telegram, dalja |
| `/privacy` | Faqja publike "si i trajtojmë të dhënat" (anglisht + shqip) |

Si është ndërtuar:

- Faqet janë client components që flasin me Supabase me çelësin **publishable** dhe sesionin e përdoruesit; çfarë
  shohin e vendos RLS. Shkrimet e ndjeshme (dokumente, përgjigje, Telegram) kalojnë nga API routes me
  `Authorization: Bearer <access_token>`.
- Inbox përdor Supabase Realtime (`postgres_changes` mbi `messages` dhe `conversations`) **dhe** një rifreskim
  çdo 15 sekonda, sepse lidhja websocket bie shpesh në rrjet celular.
- Ndërfaqja është në anglisht dhe kalon vetë në shqip kur shfletuesi është në shqip (`src/lib/ui/strings.ts`).
- Pa librari UI: një skedar CSS (`src/app/globals.css`), fonte të sistemit, i menduar së pari për telefon.

Konfigurim i nevojshëm te Supabase → **Authentication → URL Configuration**:

- *Site URL*: `https://PROJEKTI.vercel.app`
- *Redirect URLs*: `https://PROJEKTI.vercel.app/login` dhe `https://PROJEKTI.vercel.app/reset`

Pa këto, linket e konfirmimit dhe të rivendosjes së fjalëkalimit të çojnë te `localhost`.

Për ndryshime të mëtejshme me Claude Code: lexo `CLAUDE.md`, ndrysho një faqe në një kohë, dhe kontrollo vetë që
asnjë skedar me `'use client'` të mos importojë `src/lib/supabase/admin.ts`.

---

## Dita 7 — Gati për 50 biznese

- [ ] **Email**: SMTP i integruar i Supabase dërgon vetëm te anëtarët e ekipit tënd dhe 2 email/orë. Lidh një
      SMTP tënd (Authentication → Emails → SMTP Settings; p.sh. Resend) dhe riaktivizo *Confirm email*.
- [ ] **Kostoja**: spend limit te Anthropic; `monthly_ai_reply_limit = 300` për tenant (vlera fillestare në skemë).
- [ ] **Langfuse**: <https://cloud.langfuse.com> → projekt → vendos `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`
      te Vercel → Redeploy. Plani falas: 50k njësi/muaj (≈ 3 njësi për përgjigje).
- [ ] **`allowed_origins`** i vendosur për çdo tenant para se t'i japësh kodin e widget-it.
- [ ] **CI**: skeda *Actions* në GitHub është e gjelbër (typecheck, unit, RLS, end-to-end, build).
- [ ] **Privatësia**: faqja `/privacy` ekziston (linkohet nga regjistrimi). Shto adresën tënde të kontaktit në
      `src/app/privacy/page.tsx` dhe lexoje një herë: duhet të përshkruajë atë që bën realisht produkti.
- [ ] **Auth URL**: *Site URL* dhe *Redirect URLs* te Supabase (shih Ditët 5–6).
- [ ] **Backup**: plani falas i Supabase nuk përfshin backup-e të përditshme. Një herë në javë: `bash scripts/backup.sh`
- [ ] **3 bizneset e para** i lidh vetë (FAQ + widget + Telegram), shikon bisedat në Langfuse, pastaj hap për të tjerët.

---

## Sa kushton piloti (50 biznese, 1 muaj)

| Zëri | Plani | Kosto | Shënim |
|---|---|---|---|
| Vercel | Hobby | $0 | **RREZIK**: kushtet e Hobby lejojnë vetëm përdorim personal, jo-komercial. Kalo në Pro ($20/muaj) para se të marrësh pagesën e parë. |
| Supabase | Free | $0 | 500 MB DB, 2 projekte, pauzë pas 1 jave pa aktivitet. Pro = $25/muaj. |
| Voyage embeddings | pay-as-you-go | $0 | 200M tokena falas; një FAQ ≈ 2–20 mijë tokena. |
| Langfuse | Hobby | $0 | 50k njësi/muaj, 30 ditë histori. |
| Telegram Bot API | — | $0 | |
| Claude Haiku 4.5 | pay-as-you-go | **e vetmja kosto reale** | shih më poshtë |

**Supozim** për një përgjigje: ~3,000 tokena hyrës (rregullat + 6 pjesë nga knowledge base + historiku) dhe
~150 dalës → 3,000 × $1/1M + 150 × $5/1M ≈ **$0.004**.

- Tavani teorik: 50 biznese × 300 përgjigje = 15,000 përgjigje ≈ **$60/muaj**.
- **Supozim** realist për pilot (shumica e bizneseve përdorin 10–30% të kuotës): **$6–18/muaj**.
- Tavani praktik është spend limit-i që vendos te Anthropic.

Kuota 300 nuk është shifër e rastësishme: është sasia që e mban tavanin e pilotit rreth $1.2 për biznes, dhe
mjafton për ~10 përgjigje në ditë — mbi atë nivel biznesi po merr vlerë reale dhe është kandidat për plan me pagesë.

---

## Vendimet kryesore

| Vendimi | Zgjedhja | Pse | Alternativa e refuzuar |
|---|---|---|---|
| Ku ekzekutohet backend-i | Vercel route handlers (Node) | Një kod, një gjuhë, deploy me `git push`; nuk kërkon Supabase CLI/Docker në telefon | Supabase Edge Functions: deploy nga Termux kërkon CLI-në, Deno si runtime i dytë |
| Widget ↔ server | API e Vercel + polling vetëm kur paneli është hapur | Vizitori anonim nuk prek kurrë Supabase: zero sipërfaqe RLS për `anon`, zero sekret në browser | Supabase Realtime në widget: kërkon JWT të personalizuar për çdo vizitor |
| Realtime | Vetëm në panel (agjentë të loguar) | RLS zbatohet automatikisht mbi ngjarjet | — |
| Embeddings | Voyage `voyage-4-lite`, 512 dimensione | Shumëgjuhësh (shqip), 200M tokena falas, gjysma e hapësirës së 1024-dim | `gte-small` i integruar në Supabase: kryesisht anglisht |
| Kërkimi | Hibrid (vektor + full-text `simple`), skanim i saktë për tenant, pa indeks HNSW | Me pak mijëra pjesë për tenant është i shpejtë dhe ka 100% recall; HNSW me filtër tenant-i mund të kthejë më pak rezultate se sa duhen | Indeks HNSW global |
| Thirrjet API | `fetch` direkt (Claude, Voyage, Telegram, Langfuse OTLP) | Më pak varësi në Termux; API e vjetër e Langfuse mbyllet më 2026-11-16 | SDK-të zyrtare |
| Modeli | `claude-haiku-4-5` me `tool_choice` të detyruar | Përgjigje e strukturuar (`answer`, `needs_human`, `used_sources`) pa parsing teksti | Model më i madh: 3–5× kosto pa përfitim për FAQ |
| Kuota | Numërim i `usage_events` në Supabase; në limit → handoff te njeriu | Klienti nuk mbetet pa përgjigje; kostoja e AI ndalet | Bllokim i plotë i bisedës |
| Rate limiting | Funksion Postgres | Asnjë shërbim shtesë | Upstash Redis (kur trafiku ta kërkojë) |
| Tokeni i bot-it | AES-256-GCM, çelësi në env të Vercel | Një dump i DB-së nuk jep kontrollin e bot-eve | Tekst i thjeshtë në DB |

---

## `next dev` në Termux

Nuk të duhet për planin e mësipërm: logjika testohet me `pnpm test` dhe gjithçka tjetër provohet në deploy
(Telegram dhe widget-i kërkojnë gjithsesi një URL publike).

Nëse e do lokalisht: në Android, Next.js përdor kompilatorin SWC në WebAssembly (e pashë në kodin burim të
v16.3.8: `aarch64-linux-android` është në listën "wasm-first") dhe Turbopack nuk punon me të. Prandaj skripti
është `next dev --webpack` dhe konfigurimi është `next.config.mjs`. **Këtë nuk e kam ekzekutuar në një telefon.**
Rruga e sigurt nëse dështon:

```bash
pkg install -y proot-distro
proot-distro install ubuntu
proot-distro login ubuntu
# brenda Ubuntu: apt update && apt install -y curl git; instalo Node 24 dhe pnpm; pastaj `pnpm dev` në repo
```

---

## Çfarë është testuar dhe çfarë jo

**Testuar në një makinë Linux** (jo në telefon):

- 20 teste unit; migrimi + testi i plotë i izolimit në Postgres 16.
- 28 hapa end-to-end: route handlers realë → klient Supabase → PostgREST → Postgres (izolim tenant-ësh, kuota,
  handoff, idempotencë, rate limit, webhook Telegram, RLS përmes Data API).
- Widget-i në Chromium në një faqe me origjinë tjetër (CORS, XSS, rifreskim, polling, celular).
- Paneli në Chromium, 16 hapa: regjistrim, hyrje, dokumente, cilësime, lidhje Telegram, inbox, përgjigje agjenti,
  kthim te asistenti, celular, shqip, izolim midis dy bizneseve. React real; `next/link`, `next/navigation` dhe
  Supabase Realtime u zëvendësuan me imitime, sepse npm nuk ishte i arritshëm.
- Kontroll tipesh (TypeScript 6) kundër tipeve reale të React, postgrest-js dhe auth-js.

**Testuar mbi Supabase-in tënd real** (2026-10-04, brenda një transaksioni me ROLLBACK):

- trigger-i i regjistrimit, izolimi i leximit me RLS, `match_chunks` me vektorë realë pgvector, rate limit,
  idempotenca e mesazheve, numërimi i kuotës;
- privilegjet e `anon` / `authenticated` / `service_role` mbi çdo tabelë, kolonë dhe funksion, dhe përkufizimet e
  12 politikave.
- Tentativat reale `UPDATE`/`DELETE` midis tenant-ëve nuk u ekzekutuan atje (lidhja i anulon skriptet me këto
  komanda). Ekzekuto testin e plotë një herë nga Termux:
  `psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -t -f supabase/tests/rls_isolation.sql`

**Jo e testuar** — verifikohet te deploy-i i parë:

- `next build` / deploy në Vercel. Nëse build-i dështon me gabim tipesh, kopjo gabimin te Claude Code;
- thirrjet reale te Claude, Voyage, Telegram, Langfuse (u imituan sipas dokumentacionit);
- Supabase Realtime në inbox (rifreskimi çdo 15 s punon edhe pa të) dhe email-et e konfirmimit/rivendosjes;
- workflow-i i GitHub Actions; komandat e Termux në një pajisje Android.
