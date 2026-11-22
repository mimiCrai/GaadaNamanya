#!/usr/bin/env bash
# P4 #4 di Compose (stub, PASS/FAIL): lonjakan feed → tidak ada offset hilang, mutakhir ≤ 60 s setelah lonjakan, p95 end-to-end dari Prometheus.
# Lonjakan = stub menerbitkan P4_STUB_LAST_OFFSET event dengan jeda P4_STUB_INTERVAL_MS (default 3000 event × 5 ms ≈ 200 event/s).
# Tidak pernah menyentuh feed asli: SATELLITE_BASE_URL dipaksa ke stub.
# Pemakaian (Git Bash, root repo): bash scripts/satellite/p4-burst-test.sh [--keep]
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
KEEP=0
for arg in "$@"; do
    case "$arg" in
        --keep) KEEP=1 ;;
        *) echo "Argumen tidak dikenal: $arg" >&2; exit 2 ;;
    esac
done

ENV_FILE=${P4_ENV_FILE:-.env.example}
export COMPOSE_PROJECT_NAME=bnpb-p4b
OUT="test-results/p4-burst/$(date +%Y%m%dT%H%M%S)"
mkdir -p "$OUT"
unset P4_SATELLITE_BASE_URL P4_SATELLITE_TOKEN
export P4_STUB_LAST_OFFSET=${P4_STUB_LAST_OFFSET:-3000}
export P4_STUB_INTERVAL_MS=${P4_STUB_INTERVAL_MS:-5}
export P4_STUB_SPREAD_DEG=${P4_STUB_SPREAD_DEG:-0.5}
# collector OTel tidak dinaikkan di uji ini
export OTEL_SDK_DISABLED=true
compose=(docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.e2e.yml
    -f docker-compose.satellite-test.yml -f docker-compose.observability.yml)
# mode ringan: P4_AGGREGATOR_REPLICAS=1 (uji ini tidak menguji failover)
if [[ -n ${P4_AGGREGATOR_REPLICAS:-} ]]; then
    printf 'services:\n    bnpb-aggregator:\n        deploy:\n            replicas: %s\n' "$P4_AGGREGATOR_REPLICAS" > "$OUT/p4-light-override.yml"
    compose+=(-f "$OUT/p4-light-override.yml")
fi
PROM=http://localhost:$(grep '^PROMETHEUS_HOST_PORT=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
LAST=$P4_STUB_LAST_OFFSET

bold() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
container() { docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter "label=com.docker.compose.service=$1" | head -1; }
# GET di dalam container (internal key / audit token dari env container itu)
inside() {
    docker exec "$1" node -e '
        const [url, auth] = process.argv.slice(1);
        const headers = auth === "audit" ? { Authorization: `Bearer ${process.env.BNPB_AUDIT_TOKEN}` }
            : auth === "internal" ? { "X-BNPB-Internal-Key": process.env.BNPB_INTERNAL_API_KEY } : {};
        fetch(url, { headers }).then(async (r) => process.stdout.write(await r.text())).catch(() => process.stdout.write("{}"));' \
        "$2" "${3:-none}" 2>/dev/null || echo '{}'
}
jget() {
    node -e '
        let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
            try { const v = process.argv[1].split(".").reduce((o, k) => (o == null ? undefined : o[k]), JSON.parse(s));
                  console.log(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : v); } catch { console.log(""); } });' "$1"
}
stub_stat() { inside "$(container satellite-stub)" http://localhost:8090/admin/stats | jget "$1"; }
fire_offset() { local v; v=$(inside "$(container fire-processor)" http://localhost:3000/status | jget last_offset); echo "${v:--1}"; }
wait_until() {
    local description=$1 timeout=$2; shift 2
    local start=$SECONDS
    until "$@"; do
        if (( SECONDS - start > timeout )); then info "TIMEOUT (${timeout}s): $description"; return 1; fi
        sleep 1
    done
}
now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
stream_active() { [[ $(stub_stat active) == true ]]; }
published_all() { (( $(stub_stat published) >= LAST )); }
fire_done() { (( $(fire_offset) >= LAST )); }
stack_down() { "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }

trap '[[ $KEEP == 1 ]] || stack_down' EXIT
exec > >(tee "$OUT/run.log") 2>&1

bold "1. Naikkan stack ($COMPOSE_PROJECT_NAME): stub $LAST event × ${P4_STUB_INTERVAL_MS} ms, Prometheus $PROM"
stack_down
"${compose[@]}" build bnpb-aggregator fire-processor satellite-stub >/dev/null
for attempt in 1 2 3; do
    "${compose[@]}" up -d --wait canonical-store-init kafka-topic-init >/dev/null 2>&1 && break
    info "infra belum sehat (percobaan $attempt), ulangi"
done
"${compose[@]}" up -d prometheus grafana fire-processor >/dev/null
"${compose[@]}" up -d bnpb-aggregator bnpb-aggregator-entry satellite-stub >/dev/null
wait_until 'leader membuka stream ke stub' 240 stream_active
START=$(now)
info "lonjakan mulai $START"

bold '2. Lonjakan berjalan'
wait_until "stub menerbitkan offset $LAST" $(( LAST * P4_STUB_INTERVAL_MS / 1000 + 120 )) published_all
BURST_END=$(now)
info "lonjakan selesai $BURST_END; fire processor di offset $(fire_offset)"

bold '3. Tunggu fire processor mutakhir'
wait_until "fire processor mencapai offset $LAST" 300 fire_done || true
CAUGHT=$(now)
info "fire processor offset $(fire_offset) pada $CAUGHT"
sleep 20 # dua kali scrape interval supaya titik terakhir ada di Prometheus
END=$(now)

bold '4. Bukti'
agg=$(container bnpb-aggregator)
inside "$(container fire-processor)" http://localhost:3000/status > "$OUT/fire-status.json"
inside "$agg" http://localhost:3000/internal/satellite/summary internal > "$OUT/summary.json"
inside "$agg" "http://localhost:3000/internal/audit/checksum?source=SATELIT" audit > "$OUT/checksum.json"
inside "$agg" 'http://localhost:3000/internal/audit/unprocessed?source=SATELIT&limit=1000' audit > "$OUT/audit-unprocessed.json"
inside "$(container satellite-stub)" http://localhost:8090/admin/expected > "$OUT/expected.json"
for c in $(docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter label=com.docker.compose.service=bnpb-aggregator); do
    inside "$c" http://localhost:3000/internal/satellite/status internal >> "$OUT/status.ndjson"; echo >> "$OUT/status.ndjson"
done
"${compose[@]}" exec -T kafka kafka-console-consumer --bootstrap-server kafka:29092 --topic satellite.raw \
    --from-beginning --isolation-level read_committed --property print.key=true --property key.separator='|' \
    --timeout-ms 15000 > "$OUT/satellite-raw.txt" 2> "$OUT/consumer.err" || true
set +e
node scripts/satellite/lib/verify-satellite-raw.mjs --raw "$OUT/satellite-raw.txt" --expected "$OUT/expected.json" \
    --audit "$OUT/audit-unprocessed.json" --status "$OUT/status.ndjson" > "$OUT/verify-raw.txt"
raw_ok=$?
node scripts/satellite/p4-lag-report.mjs --start "$START" --burst-end "$BURST_END" --end "$END" --prometheus "$PROM" --out "$OUT/lag-report.txt"
lag_ok=$?
set -e
"${compose[@]}" logs --no-color fire-processor bnpb-aggregator > "$OUT/compose.log" 2>&1 || true

{
    echo '== Pemeriksaan =='
    cat "$OUT/verify-raw.txt" | sed 's/^/  /'
    echo "  fire processor last_offset $(jget last_offset < "$OUT/fire-status.json") (target $LAST)"
    echo "  lonjakan $START .. $BURST_END, mutakhir $CAUGHT"
    sed 's/^/  /' "$OUT/lag-report.txt"
    if (( raw_ok == 0 && lag_ok == 0 )) && (( $(jget last_offset < "$OUT/fire-status.json") >= LAST )); then echo 'HASIL AKHIR: PASS'; else echo 'HASIL AKHIR: FAIL'; fi
} | tee "$OUT/result.txt"
info "artefak: $OUT (Grafana dashboard 'BNPB Overview' → panel P4 selama --keep)"
grep -q 'HASIL AKHIR: PASS' "$OUT/result.txt"
