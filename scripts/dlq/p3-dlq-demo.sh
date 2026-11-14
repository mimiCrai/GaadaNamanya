#!/usr/bin/env bash
# Demo Tahap 1 (P3 #2, #3, #5 + /internal/audit/unprocessed + metrik DLQ) di Docker Compose.
# Prasyarat: `.env` sudah disalin dari `.env.example`, `docker compose up -d --build` sudah sehat,
# pengguna media/field/internal sudah dibuat (lihat bagian "Persiapan" di README; ditambah role internal).
#
# Pemakaian (Git Bash, dari root repo):  bash scripts/dlq/p3-dlq-demo.sh
set -euo pipefail

dotenv() { grep "^$1=" .env | cut -d= -f2- | tr -d '\r'; }
json() { sed -E "s/.*\"$1\":\"([^\"]+)\".*/\1/"; }
PW=${PW:-choose-a-password}
login() { curl -s -X POST localhost:3001/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PW\"}"; }

AGG=localhost:$(dotenv BNPB_AGGREGATOR_HOST_PORT)
API=localhost:$(dotenv BNPB_CLIENT_API_HOST_PORT)
AUDIT=$(dotenv BNPB_AGGREGATOR_AUDIT_TOKEN)
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "1. Sisipkan record PVMBG beracun (volcano_id tidak ada di tabel referensi BNPB) langsung ke DB mock"
POISON_ID="poison-$(date +%s)"
docker compose exec -T pvmbg-store psql -U "$(dotenv PVMBG_STORE_DB_USER)" -d "$(dotenv PVMBG_STORE_DB_NAME)" -c \
    "INSERT INTO volcanic_reports VALUES ('$POISON_ID','GUNUNG_FIKTIF','Siaga',1,100,now(),NULL);"
echo "menunggu beberapa siklus poll (overlap since akan mengirim record yang sama lebih dari sekali)..."
sleep 12

step "2. Audit Lampiran A: GET /internal/audit/unprocessed?source=PVMBG (token audit)"
curl -s "$AGG/internal/audit/unprocessed?source=PVMBG&limit=5" -H "Authorization: Bearer $AUDIT"; echo
echo "Diharapkan: item status=parked, retryable=false, reason='validation_failed: volcano_id ''GUNUNG_FIKTIF'' tidak ada di tabel referensi BNPB'"

step "3. Paginasi: limit=1 sampai next_cursor null"
CURSOR=""
for page in 1 2 3 4 5; do
    URL="$AGG/internal/audit/unprocessed?limit=1${CURSOR:+&cursor=$CURSOR}"
    BODY=$(curl -s "$URL" -H "Authorization: Bearer $AUDIT")
    echo "halaman $page: $BODY"
    CURSOR=$(echo "$BODY" | sed -nE 's/.*"next_cursor":"([^"]+)".*/\1/p')
    [ -z "$CURSOR" ] && break
done

step "4. Validasi dan auth audit: limit=1001 → 400, token salah → 401"
curl -s -w ' HTTP %{http_code}\n' "$AGG/internal/audit/unprocessed?limit=1001" -H "Authorization: Bearer $AUDIT"
curl -s -w ' HTTP %{http_code}\n' "$AGG/internal/audit/unprocessed" -H "Authorization: Bearer salah"

step "5. Poll PVMBG tetap HEALTHY (record lain tetap diproses, tidak ada restart)"
curl -s "$API/hazards?source=PVMBG" -H "Authorization: Bearer $(login field@example.test | json accessToken)" | grep -o '"meta".*'
for c in $(docker compose ps -q bnpb-aggregator); do docker inspect -f '{{.Name}} restarts={{.RestartCount}} status={{.State.Status}}' "$c"; done

step "6. Inspeksi DLQ hanya untuk Internal Ops (P3 #5)"
MSG=$(curl -s "$AGG/internal/audit/unprocessed?source=PVMBG&limit=1000" -H "Authorization: Bearer $AUDIT" | grep -oE 'msg-[a-f0-9]{24}' | tail -1)
for who in media field; do
    echo -n "$who → "; curl -s -w ' HTTP %{http_code}\n' "$API/internal-ops/dlq/$MSG" -H "Authorization: Bearer $(login $who@example.test | json accessToken)"
done
OPS=$(login ops@example.test | json accessToken)
echo -n "internal → "; curl -s "$API/internal-ops/dlq/$MSG" -H "Authorization: Bearer $OPS" | head -c 600; echo
echo "raw bytes (sha256 harus sama dengan field sha256 di atas):"
curl -s "$API/internal-ops/dlq/$MSG/raw" -H "Authorization: Bearer $OPS" | sha256sum

step "7. Metrik Prometheus"
curl -s "$AGG/metrics" | grep -E '^bnpb_aggregator_(unprocessed_messages|unprocessed_retry_total|parse_failures_total)'
