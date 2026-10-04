#!/usr/bin/env bash
# Aplikon migrimet SQL me radhë duke përdorur vetëm psql — pa Docker dhe pa Supabase CLI,
# prandaj punon direkt në Termux. Çdo skedar ekzekutohet një herë, brenda një transaksioni.
# Përdorim: bash scripts/migrate.sh      (lexon DATABASE_URL nga .env.local)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ROOT/.env.local" ]; then
  set -a; . "$ROOT/.env.local"; set +a
fi
: "${DATABASE_URL:?Vendos DATABASE_URL (Supabase > Connect > Session pooler) në .env.local}"
DIR="${MIGRATIONS_DIR:-$ROOT/supabase/migrations}"
PSQL=(psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1)

"${PSQL[@]}" -c "create schema if not exists private;
  create table if not exists private.schema_migrations (
    name text primary key, applied_at timestamptz not null default now());" 2>/dev/null

for f in "$DIR"/*.sql; do
  name="$(basename "$f")"
  if [ "$("${PSQL[@]}" -At -c "select 1 from private.schema_migrations where name = '$name'")" = "1" ]; then
    echo "= $name (e aplikuar më parë)"
    continue
  fi
  "${PSQL[@]}" -1 -f "$f" -c "insert into private.schema_migrations (name) values ('$name')"
  echo "+ $name"
done
