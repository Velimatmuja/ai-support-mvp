#!/usr/bin/env bash
# Teston migrimin + RLS në një Postgres lokal të përkohshëm (pa Docker, pa pgvector).
# Përdorim: bash scripts/local-db/run.sh   (kërkon postgres + psql në PATH)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PGBIN:-$(dirname "$(command -v postgres || echo /usr/lib/postgresql/16/bin/postgres)")}"
DIR="$(mktemp -d)"
PORT="${PORT:-54329}"
trap '"$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT

"$PGBIN/initdb" -D "$DIR/data" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=''" -l "$DIR/log" -w start >/dev/null
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$DIR" -p "$PORT" -U postgres -d postgres)

"${PSQL[@]}" -f "$ROOT/scripts/local-db/supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  # pgvector mungon lokalisht: hiq extension-in dhe typmod-in (512).
  sed -e '/^create extension if not exists vector/d' -e 's/extensions\.vector(512)/extensions.vector/g' "$f" \
    | "${PSQL[@]}" -f -
  echo "migrimi OK: $(basename "$f")"
done
"${PSQL[@]}" -t -f "$ROOT/supabase/tests/rls_isolation.sql" 2>&1 | grep -v "text-search query"
