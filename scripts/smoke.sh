#!/usr/bin/env bash
# Smoke test kundër deploy-it REAL (Vercel + Supabase + Voyage + Claude):
#   login -> lexo widget_key përmes RLS -> ngarko një FAQ -> bëj një pyetje si vizitor.
# Përdorim: bash scripts/smoke.sh email@shembull.com 'fjalëkalimi'
# Kërkon: curl, jq dhe .env.local me APP_URL + çelësat publikë të Supabase.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/.env.local" ]; then set -a; . "$ROOT/.env.local"; set +a; fi
EMAIL="${1:?Përdorim: bash scripts/smoke.sh EMAIL FJALEKALIM}"
PASSWORD="${2:?Përdorim: bash scripts/smoke.sh EMAIL FJALEKALIM}"
: "${APP_URL:?mungon APP_URL}" "${NEXT_PUBLIC_SUPABASE_URL:?mungon NEXT_PUBLIC_SUPABASE_URL}" "${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:?mungon NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}"
SB="$NEXT_PUBLIC_SUPABASE_URL"
PK="$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"
APP="${APP_URL%/}"

echo "1) Login"
LOGIN="$(curl -sS "$SB/auth/v1/token?grant_type=password" -H "apikey: $PK" -H 'content-type: application/json' \
  -d "$(jq -n --arg e "$EMAIL" --arg p "$PASSWORD" '{email: $e, password: $p}')")"
TOKEN="$(jq -r '.access_token // empty' <<<"$LOGIN")"
[ -n "$TOKEN" ] || { echo "   Login dështoi: $LOGIN"; exit 1; }

echo "2) widget_key i tenant-it tim (lexuar me RLS, si do ta lexojë paneli)"
TENANTS="$(curl -sS "$SB/rest/v1/tenants?select=name,widget_key" -H "apikey: $PK" -H "authorization: Bearer $TOKEN")"
[ "$(jq 'length' <<<"$TENANTS")" = "1" ] || { echo "   Prita saktësisht 1 tenant, mora: $TENANTS"; exit 1; }
KEY="$(jq -r '.[0].widget_key' <<<"$TENANTS")"
echo "   $(jq -r '.[0].name' <<<"$TENANTS") -> $KEY"

echo "3) Ngarkim i një FAQ në knowledge base"
CONTENT='Smoke test FAQ. Our shop is open Monday to Saturday from 08:00 to 20:00 and closed on Sunday. Delivery inside the city takes one working day and costs 200 lek.'
INGEST="$(curl -sS -X POST "$APP/api/kb/ingest" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "$(jq -n --arg c "$CONTENT" '{title: "Smoke test FAQ", content: $c}')")"
echo "   $INGEST"
jq -e '.documentId or .error == "duplicate_document"' <<<"$INGEST" >/dev/null || { echo "   Ngarkimi dështoi"; exit 1; }

echo "4) Pyetje si vizitor anonim i widget-it"
REPLY="$(curl -sS -X POST "$APP/api/widget/message" -H 'content-type: application/json' \
  -d "$(jq -n --arg k "$KEY" '{key: $k, text: "What are your opening hours?"}')")"
jq '{status, reply: .reply.content}' <<<"$REPLY"
jq -e '.reply.content | length > 0' <<<"$REPLY" >/dev/null || { echo "   Nuk erdhi përgjigje: $REPLY"; exit 1; }
echo "SMOKE TEST OK"
