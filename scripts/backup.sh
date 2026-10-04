#!/usr/bin/env bash
# Backup i të dhënave të aplikacionit (schema public) me pg_dump. Plani falas i Supabase
# nuk përfshin backup-e të përditshme, ndaj ekzekutoje një herë në javë gjatë pilotit.
# Përdorim: bash scripts/backup.sh [dosja]      (parazgjedhje: ~/storage/downloads në Termux)
# Rikthim:  pg_restore --clean --if-exists -d "$DATABASE_URL" skedari.dump
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ROOT/.env.local" ]; then
  set -a; . "$ROOT/.env.local"; set +a
fi
: "${DATABASE_URL:?Vendos DATABASE_URL në .env.local}"
DEST="${1:-$HOME/storage/downloads}"
[ -d "$DEST" ] || DEST="$ROOT"
FILE="$DEST/supportbot-$(date +%F-%H%M).dump"
pg_dump "$DATABASE_URL" --schema=public --no-owner --no-privileges --format=custom --file="$FILE"
echo "Backup: $FILE ($(du -h "$FILE" | cut -f1))"
