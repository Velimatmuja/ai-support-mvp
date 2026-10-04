#!/usr/bin/env bash
# Test end-to-end pa asnjë shërbim të jashtëm:
#   Postgres i përkohshëm + PostgREST real  (= Data API e Supabase)
#   + shërbime të imituara: Voyage, Anthropic, Telegram, Langfuse, Supabase Auth
#   + route handlers realë të src/app/api.
# Kërkon: postgres + psql, node >= 22.18, dhe binarin `postgrest`
# (https://github.com/PostgREST/postgrest/releases) në PATH ose te $POSTGREST_BIN.
# Jo për Termux: ekzekutohet në GitHub Actions (.github/workflows/ci.yml).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(dirname "$(command -v postgres || echo /usr/lib/postgresql/16/bin/postgres)")}"
POSTGREST_BIN="${POSTGREST_BIN:-postgrest}"
DIR="$(mktemp -d)"
PG_PORT=54339
export E2E_REST_PORT=54340
export E2E_PG_HOST="$DIR" E2E_PG_PORT="$PG_PORT"   # për regjistrimin e imituar (insert në auth.users)
export E2E_JWT_SECRET="e2e-jwt-secret-e2e-jwt-secret-e2e-jwt-secret"

cleanup() {
  [ -n "${REST_PID:-}" ] && kill "$REST_PID" 2>/dev/null || true
  "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DIR/data" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PG_PORT -k $DIR -c listen_addresses=''" -l "$DIR/log" -w start >/dev/null
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$DIR" -p "$PG_PORT" -U postgres -d postgres)

"${PSQL[@]}" -f "$ROOT/scripts/local-db/supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  sed -e '/^create extension if not exists vector/d' -e 's/extensions\.vector(512)/extensions.vector/g' "$f" | "${PSQL[@]}" -f -
done

# Dy regjistrime: trigger-i krijon tenant + profil + knowledge base + kanal widget.
"${PSQL[@]}" -c "insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a@test.local', '{\"business_name\":\"Kafe Alba\"}'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b@test.local', '{\"business_name\":\"Dyqani Beta\"}');"

PGRST_DB_URI="postgres://postgres@/postgres?host=$DIR&port=$PG_PORT" \
PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET="$E2E_JWT_SECRET" \
PGRST_SERVER_HOST=127.0.0.1 PGRST_SERVER_PORT="$E2E_REST_PORT" PGRST_LOG_LEVEL=crit \
  "$POSTGREST_BIN" >"$DIR/postgrest.log" 2>&1 &
REST_PID=$!
for _ in $(seq 1 50); do
  curl -s -o /dev/null "http://127.0.0.1:$E2E_REST_PORT/" && break
  sleep 0.1
done
curl -s -o /dev/null "http://127.0.0.1:$E2E_REST_PORT/" || { echo "PostgREST nuk u nis:"; cat "$DIR/postgrest.log"; exit 1; }

cd "$ROOT"
node tests/e2e/run.ts
