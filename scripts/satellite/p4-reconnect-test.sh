#!/usr/bin/env bash

set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

MODE=stub
PAUSE=0
KEEP=0
for arg in "$@"; do
    case "$arg" in
        --real) MODE=real ;;
        --pause) PAUSE=1 ;;
        --keep) KEEP=1 ;;
        *) echo "Argumen tidak dikenal: $arg" >&2; exit 2 ;;
    esac
done

ENV_FILE=${P4_ENV_FILE:-.env.example}
dotenv() { [[ -f .env ]] && grep "^$1=" .env | head -1 | cut -d= -f2- | tr -d '\r'; return 0; }

export COMPOSE_PROJECT_NAME=bnpb-p4
compose=(docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.satellite-test.yml)
OUT="test-results/p4-reconnect/$(date +%Y%m%dT%H%M%S)-$MODE"
mkdir -p "$OUT"
export P4_STUB_LAST_OFFSET=${P4_STUB_LAST_OFFSET:-1200}
export P4_STUB_INTERVAL_MS=${P4_STUB_INTERVAL_MS:-300}
STEP_PROGRESS=${STEP_PROGRESS:-30}

bold() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }

if [[ $MODE == real ]]; then
    token=${SATELLITE_TOKEN:-$(dotenv BNPB_AGGREGATOR_SATELLITE_TOKEN)}
    if [[ -z $token || $token == replace-with-group-token || $token == fake-* ]]; then
        echo 'Token grup tidak ada: set SATELLITE_TOKEN atau BNPB_AGGREGATOR_SATELLITE_TOKEN di .env.' >&2
        exit 2
    fi
    lock="$(node -e "console.log(require('os').tmpdir())")/bnpb-satellite-stream.lock"
    if [[ -e $lock ]]; then
        echo "Lock observer $lock masih ada: mungkin ada koneksi stream lain. Hentikan dulu." >&2
        exit 2
    fi
    export P4_SATELLITE_BASE_URL=${SATELLITE_BASE_URL:-https://satellite.naufarrel.dev}
    export P4_SATELLITE_TOKEN=$token
    export P4_SATELLITE_IDLE_TIMEOUT_MS=60000
    echo 'PERINGATAN: mode --real membuka SATU koneksi stream ke feed asli lewat leader.'
    echo '            Pastikan tidak ada stack/observer lain yang terhubung ke feed (429 too_many_connections).'
fi

containers() {
    docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
        --filter "label=com.docker.compose.service=$1" --filter status=running
}
# HTTP call inside an Aggregator container (internal key / audit token come from the container env).
agg() {
    docker exec "$1" node -e '
        const [method, path, auth] = process.argv.slice(1);
        const headers = auth === "audit"
            ? { Authorization: `Bearer ${process.env.BNPB_AUDIT_TOKEN}` }
            : { "X-BNPB-Internal-Key": process.env.BNPB_INTERNAL_API_KEY };
        fetch("http://localhost:3000" + path, { method, headers })
            .then(async (r) => process.stdout.write(await r.text()))
            .catch(() => process.stdout.write("{}"));' "$2" "$3" "${4:-internal}" 2>/dev/null || echo '{}'
}
stub() {
    local container
    container=$(containers satellite-stub)
    docker exec "$container" node -e '
        const [method, path, body] = process.argv.slice(1);
        fetch("http://localhost:8090" + path, { method, body: body || undefined, headers: { "content-type": "application/json" } })
            .then(async (r) => process.stdout.write(await r.text()));' "$1" "$2" "${3:-}"
}
jget() {
    node -e '
        let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
            try { const v = process.argv[1].split(".").reduce((o, k) => (o == null ? undefined : o[k]), JSON.parse(s));
                  console.log(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : v); } catch { console.log(""); } });' "$1"
}
status_of() { agg "$1" GET /internal/satellite/status; }
leader() {
    local c
    for c in $(containers bnpb-aggregator); do
        if [[ $(status_of "$c" | jget leader) == true ]]; then echo "$c"; return 0; fi
    done
    return 1
}
connected_leader() {
    local c
    c=$(leader) || return 1
    [[ $(status_of "$c" | jget connected) == true ]] && echo "$c"
}
durable() {
    local c v
    c=$(leader) || { echo -1; return; }
    v=$(status_of "$c" | jget last_offset_durable)
    echo "${v:--1}"
}
wait_until() {
    local description=$1 timeout=$2
    shift 2
    local start=$SECONDS
    until "$@"; do
        if (( SECONDS - start > timeout )); then
            info "TIMEOUT (${timeout}s): $description"
            return 1
        fi
        sleep 1
    done
}
progressed_past() { (( $(durable) >= $1 )); }
num() { local v; v=$(status_of "$1" | jget "$2"); echo "${v:-0}"; }
reconnects_sum() {
    status_of "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).reconnects||{};console.log(Object.values(r).reduce((a,b)=>a+b,0))}catch{console.log(0)}})'
}
# Every fault must visibly take effect; otherwise the run FAILS instead of passing on an untouched stream.
FAULTS_OK=()
FAULTS_FAIL=()
check() {
    local description=$1
    shift
    if "$@"; then FAULTS_OK+=("$description"); info "efek OK: $description"
    else FAULTS_FAIL+=("$description"); info "EFEK TIDAK TERLIHAT: $description"; fi
}
live() { [[ $MODE == real ]] || (( $1 < P4_STUB_LAST_OFFSET )); }
wait_progress() {
    local base target
    base=$(durable)
    target=$(( base + ${1:-$STEP_PROGRESS} ))
    if [[ $MODE == stub ]] && (( target > P4_STUB_LAST_OFFSET )); then target=$P4_STUB_LAST_OFFSET; fi
    wait_until "durable >= $target" 120 progressed_past "$target"
    info "durable: $base → $(durable)"
}

cleanup() {
    local code=$?
    for c in $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter label=com.docker.compose.service=bnpb-aggregator); do
        docker unpause "$c" >/dev/null 2>&1 || true
    done
    "${compose[@]}" logs --no-color bnpb-aggregator satellite-stub > "$OUT/compose.log" 2>&1 || true
    if [[ $KEEP == 0 ]]; then "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi
    exit "$code"
}
trap cleanup EXIT

bold "1. Naikkan stack terisolasi ($COMPOSE_PROJECT_NAME, feed: $MODE)"
"${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
# Build first: building images while 10 mongod boot for the first time can push a node past its healthcheck window.
"${compose[@]}" build
started=0
for attempt in 1 2 3; do
    if "${compose[@]}" up -d; then started=1; break; fi
    info "compose up gagal (percobaan $attempt): boot pertama Mongo lambat; node di-restart otomatis, coba lagi"
    sleep 10
done
(( started == 1 )) || { echo 'Stack tidak bisa dinaikkan' >&2; exit 1; }
wait_until 'leader terhubung ke feed' 240 connected_leader
L1=$(leader)
info "leader: $(docker inspect -f '{{.Name}}' "$L1")  from=$(status_of "$L1" | jget current_from)"

bold '2. Biarkan stream berjalan'
wait_until 'durable >= 40' 180 progressed_past 40
info "durable: $(durable)"

bold '3. Putus koneksi di tengah stream'
rc_before=$(reconnects_sum "$L1")
at_fault=$(durable)
if [[ $MODE == stub ]]; then
    stub POST /admin/fault '{"drop_now":true}' >/dev/null
    info 'stub memutus socket di tengah sebuah event'
else
    info "POST /internal/satellite/disconnect → $(agg "$L1" POST /internal/satellite/disconnect)"
fi
wait_progress
check "putus koneksi saat stream live (durable=$at_fault)" live "$at_fault"
check 'putus koneksi memicu reconnect' test "$(reconnects_sum "$(leader)")" -gt "$rc_before"

if [[ $MODE == stub ]]; then
    bold '4. Celah offset (stub melompati satu offset di koneksi ini)'
    stub POST /admin/fault '{"skip_next":true}' >/dev/null
    wait_progress
    info "gaps_total leader: $(status_of "$(leader)" | jget gaps)"
    check 'celah offset terdeteksi (gaps_total >= 1)' test "$(num "$(leader)" gaps)" -ge 1

    bold '5. Dua kali 503 lalu putus'
    stub POST /admin/fault '{"status":503,"count":2}' >/dev/null
    stub POST /admin/fault '{"drop_now":true}' >/dev/null
    wait_progress
    check '503 dijawab dengan backoff (reconnects_total{http_503} >= 2)' test "$(num "$(leader)" reconnects.http_503)" -ge 2
fi

bold '6. Kill leader di tengah stream (docker kill -s KILL)'
L1=$(leader)
before=$(durable)
docker kill -s KILL "$L1" >/dev/null
info "dibunuh: $(docker inspect -f '{{.Name}}' "$L1") pada durable=$before"
check "kill leader saat stream live (durable=$before)" live "$before"
new_leader() { local c; c=$(connected_leader) && [[ $c != "$L1" ]]; }
wait_until 'leader baru terhubung' 120 new_leader
L2=$(leader)
resume_from=$(num "$L2" current_from)
info "leader baru: $(docker inspect -f '{{.Name}}' "$L2")  from=$resume_from"
check "leader baru melanjutkan dari checkpoint broker (from=$resume_from > durable lama $before)" test "$resume_from" -gt "$before"
wait_progress

if [[ $PAUSE == 1 ]]; then
    bold '7. Zombie: bekukan leader (docker pause), leader berikutnya mengambil alih'
    L2=$(leader)
    docker pause "$L2" >/dev/null
    info "dibekukan: $(docker inspect -f '{{.Name}}' "$L2")"
    other_leader() { local c; c=$(leader) && [[ $c != "$L2" ]]; }
    wait_until 'leader ketiga terpilih' 120 other_leader
    L3=$(leader)
    if [[ $MODE == stub ]]; then
        saw_429() { (( $(status_of "$L3" | jget reconnects.http_429 || echo 0) >= 1 )) 2>/dev/null; }
        wait_until 'leader ketiga menerima 429 (koneksi zombie masih terbuka)' 60 saw_429 || true
        info "http_429 di leader ketiga: $(status_of "$L3" | jget reconnects.http_429)"
        check 'leader ketiga mendapat 429 selama koneksi zombie terbuka' test "$(num "$L3" reconnects.http_429)" -ge 1
        stub POST /admin/fault '{"kill_active":true}' >/dev/null # server "notices" the dead connection
    fi
    l3_connected() { [[ $(status_of "$L3" | jget connected) == true ]]; }
    wait_until 'leader ketiga terhubung' 120 l3_connected
    wait_progress
    docker unpause "$L2" >/dev/null
    sleep 5
    info "zombie setelah unpause: $(status_of "$L2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"{}");console.log(`leader=${j.leader} connected=${j.connected}`)})')"
    docker logs --since 30s "$L2" 2>&1 | grep -E 'leadership_lost|Discarded work|Background leadership changed' | tail -3 | sed 's/^/   log zombie: /' || true
    zombie_quiet() { [[ $(status_of "$L2" | jget connected) != true && $(status_of "$L2" | jget leader) != true ]]; }
    check 'zombie setelah unpause tidak memegang stream maupun lease' zombie_quiet
fi

bold '8. Tunggu stream mutakhir'
if [[ $MODE == stub ]]; then
    complete() { (( $(durable) >= P4_STUB_LAST_OFFSET )); }
    wait_until "durable = $P4_STUB_LAST_OFFSET" 240 complete || true
else
    caught_up() {
        local s
        s=$(status_of "$(leader)")
        [[ -n $(echo "$s" | jget latest_offset) ]] && (( $(echo "$s" | jget lag_offsets) <= 1 ))
    }
    wait_until 'lag_offsets <= 1' 180 caught_up || true
fi
LATEST=$(status_of "$(leader)" | jget latest_offset)
info "durable: $(durable)  latest_offset feed: ${LATEST:--}"

bold '9. Verifikasi isi satellite.raw'
"${compose[@]}" exec -T kafka kafka-console-consumer --bootstrap-server kafka:29092 --topic satellite.raw \
    --from-beginning --isolation-level read_committed --property print.key=true --property key.separator='|' \
    --timeout-ms 15000 > "$OUT/satellite-raw.txt" 2> "$OUT/consumer.err" || true
: > "$OUT/status.ndjson"
for c in $(containers bnpb-aggregator); do status_of "$c" >> "$OUT/status.ndjson"; echo >> "$OUT/status.ndjson"; done
agg "$(containers bnpb-aggregator | head -1)" GET '/internal/audit/unprocessed?source=SATELIT&limit=1000' audit > "$OUT/audit-unprocessed.json"
verify=(node scripts/satellite/lib/verify-satellite-raw.mjs --raw "$OUT/satellite-raw.txt" --audit "$OUT/audit-unprocessed.json" --status "$OUT/status.ndjson")
if [[ $MODE == stub ]]; then
    stub GET /admin/expected > "$OUT/expected.json"
    stub GET /admin/stats > "$OUT/stub-stats.json"
    info "stub: $(cat "$OUT/stub-stats.json")"
    verify+=(--expected "$OUT/expected.json")
else
    verify+=(--latest "$LATEST")
fi
set +e
"${verify[@]}" | tee "$OUT/result.txt"
result=${PIPESTATUS[0]}
set -e
{
    echo '== Efek gangguan =='
    for f in "${FAULTS_OK[@]}"; do echo "  OK    $f"; done
    for f in "${FAULTS_FAIL[@]}"; do echo "  GAGAL $f"; done
    if (( ${#FAULTS_FAIL[@]} > 0 )); then echo 'HASIL AKHIR: FAIL (ada gangguan yang tidak berefek)'; result=1
    elif (( result == 0 )); then echo 'HASIL AKHIR: PASS'; else echo 'HASIL AKHIR: FAIL'; fi
} | tee -a "$OUT/result.txt"
(( ${#FAULTS_FAIL[@]} == 0 )) || result=1
info "artefak: $OUT"
exit "$result"
