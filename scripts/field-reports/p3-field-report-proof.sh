#!/usr/bin/env bash
# Bukti P3 #6 di Compose (PASS/FAIL), project terisolasi bnpb-p3f, nilai demo .env.example.
#   Beban: 500 report_id unik, konkurensi 50, ±20% kiriman ulang, 10 konflik isi, token di-refresh (TTL 60 s).
#   Chaos acak selama beban: kill -9 Client API, kill -9 consumer, compose stop Aggregator ±15 s. Setiap gangguan wajib berefek.
#   Verifikasi setelah lag = 0 (kafka-consumer-groups): tiap 202 tersimpan tepat sekali dengan isi yang dikirim (konflik:
#   kiriman pertama menang), tanpa dokumen fantom, tanpa entri DLQ selain konflik yang diharapkan, tanpa baca partial.
# Pemakaian (Git Bash, root repo): bash scripts/field-reports/p3-field-report-proof.sh [--keep] [--baseline]
#   --baseline: beban yang sama tanpa chaos, hanya untuk pembanding latensi (bukan bukti P3 #6)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
KEEP=0
BASELINE=0
for arg in "$@"; do
    case "$arg" in
        --keep) KEEP=1 ;;
        --baseline) BASELINE=1 ;;
        *) echo "Argumen tidak dikenal: $arg" >&2; exit 2 ;;
    esac
done

export COMPOSE_PROJECT_NAME=bnpb-p3f
# shellcheck source=../dlq/lib/p3-stack.sh
source scripts/dlq/lib/p3-stack.sh
OUT="test-results/p3-field-report/$(date +%Y%m%dT%H%M%S)$( (( BASELINE == 1 )) && echo -baseline || true)"
mkdir -p "$OUT"
p3_override "$OUT"
exec > >(tee "$OUT/run.log") 2>&1
NET="${COMPOSE_PROJECT_NAME}_default"
GROUP=$(envval FIELD_REPORT_PROCESSOR_KAFKA_GROUP_ID); GROUP=${GROUP:-field-report-processor-group}
TOPIC=$(envval FIELD_REPORT_TOPIC); TOPIC=${TOPIC:-field-reports}
HOST_ROOT=$(pwd -W 2>/dev/null || pwd)
LOAD_NAME="${COMPOSE_PROJECT_NAME}-load"

cleanup() {
    local code=$?
    docker rm -f "$LOAD_NAME" >/dev/null 2>&1 || true
    "${compose[@]}" logs --no-color bnpb-client-api field-report-processor bnpb-aggregator > "$OUT/compose.log" 2>&1 || true
    if [[ $KEEP == 0 ]]; then "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi
    exit "$code"
}
trap cleanup EXIT

# node:22 container on the Compose network with the generator mounted read-only and the result directory writable
# runner <docker-run options…> -- <command…>
runner() {
    local opts=()
    while [[ $1 != -- ]]; do opts+=("$1"); shift; done
    shift
    docker run "${opts[@]}" --network "$NET" \
        -v "$HOST_ROOT/scripts/field-reports/lib:/work/lib:ro" -v "$HOST_ROOT/$OUT:/work/out" \
        -e OUT_DIR=/work/out node:22-alpine "$@"
}
progress() { cat "$OUT/progress.json" 2>/dev/null | jget "$1"; }
num() { local v; v=$(progress "$1"); echo "${v:-0}"; }
describe_group() { "${compose[@]}" exec -T kafka kafka-consumer-groups --bootstrap-server kafka:29092 --describe --group "$GROUP" 2>/dev/null | tr -d '\r'; }
# total lag over all partitions; "-" (no committed offset yet) counts as the whole log
group_lag() {
    describe_group | awk -v t="$TOPIC" '$2==t { cur=($4=="-")?0:$4; lag+=($5-cur) } END { printf "%d\n", lag+0 }'
}
lag_positive() { (( $(group_lag) > 0 )); }
lag_zero() { local d; d=$(describe_group); [[ -n $d ]] && (( $(group_lag) == 0 )) && ! awk -v t="$TOPIC" '$2==t && $5>0 && $4=="-" {f=1} END {exit !f}' <<<"$d"; }
proc_metric() {
    docker exec "$(first field-report-processor)" node -e 'fetch("http://localhost:3000/metrics").then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>{})' 2>/dev/null \
        | { grep -E "^$1" || true; } | awk '{s+=$NF} END {printf "%d\n", s}'
}
proc_ready() { [[ -n $(first field-report-processor) ]] && docker exec "$(first field-report-processor)" node -e 'fetch("http://localhost:3000/health/ready").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' 2>/dev/null; }
api_ready() { [[ -n $(first bnpb-client-api) ]] && [[ $(api GET /health/ready '' | cut -d' ' -f1) == 200 ]]; }
entry_ready() { agg1 GET /health/ready | grep -q '"ok"'; }

bold "0. Stack terisolasi $COMPOSE_PROJECT_NAME (Client API, Kafka, field-report-processor, Aggregator ×3, Mongo sharded)"
stack_up bnpb-client-api field-report-processor
wait_until 'leader Aggregator' 240 has_leader
wait_until 'Client API siap (producer Kafka tersambung)' 180 api_ready
wait_until 'consumer tergabung di group' 180 proc_ready
COMPOSE_ENV_FILES="$ENV_FILE" bash scripts/seed-users.sh | sed 's/^/   /'
API_C=$(first bnpb-client-api); PROC_C=$(first field-report-processor)
show "${compose[*]} exec -T kafka kafka-configs --describe --entity-type topics --entity-name $TOPIC"
"${compose[@]}" exec -T kafka kafka-topics --bootstrap-server kafka:29092 --describe --topic "$TOPIC" 2>/dev/null | tr -d '\r' | tee "$OUT/topic.txt" | head -1 | sed 's/^/   /'
"${compose[@]}" exec -T kafka kafka-configs --bootstrap-server kafka:29092 --describe --entity-type topics --entity-name "$TOPIC" 2>/dev/null | tr -d '\r' | tee -a "$OUT/topic.txt" | sed 's/^/   /'
check 'topic field-reports: 3 partisi' grep -q 'PartitionCount: 3' "$OUT/topic.txt"
check 'topic field-reports: retention.ms=2592000000 (30 hari, celah "retensi topic")' grep -q 'retention.ms=2592000000' "$OUT/topic.txt"

bold '1. Beban: 500 laporan, konkurensi 50, ±20% kiriman ulang, 10 konflik (latar belakang)'
# long enough that all three faults happen while the load is still running
DURATION_S=${P3_LOAD_DURATION_S:-150}
runner -d --name "$LOAD_NAME" -e API_URL=http://bnpb-client-api:3000 -e AUTH_URL=http://bnpb-auth:3000 \
    -e COUNT="${P3_LOAD_COUNT:-500}" -e CONCURRENCY=50 -e RESEND_RATIO=0.2 -e CONFLICTS=10 -e DURATION_S="$DURATION_S" \
    -- node /work/lib/load-field-reports.mjs load >/dev/null
started() { (( $(num accepted) >= 30 )); }
wait_until 'beban berjalan (≥ 30 balasan 202)' 120 started

bold '2. Chaos acak selama beban'
mapfile -t FAULTS < <(printf '%s\n' kill_api kill_consumer stop_aggregator | sort -R)
(( BASELINE == 1 )) && { FAULTS=(); info 'mode --baseline: tanpa gangguan (hasil hanya pembanding latensi)'; }
info "urutan gangguan: ${FAULTS[*]}"
for fault in "${FAULTS[@]}"; do
    sleep $(( RANDOM % 8 + 4 ))
    case "$fault" in
        kill_api)
            net0=$(num network); s0=$(num status.503)
            killed_at=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
            show "docker kill -s KILL $(cname "$API_C")"
            docker kill -s KILL "$API_C" >/dev/null
            sleep 3
            show "docker start $(cname "$API_C")"
            docker start "$API_C" >/dev/null
            wait_until 'Client API siap lagi' 120 api_ready || true
            # the restart window is reported separately in the latency summary
            printf '{"fault":"kill_api","start":"%s","ready":"%s"}\n' "$killed_at" "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" >> "$OUT/chaos.ndjson"
            net1=$(num network); s1=$(num status.503)
            info "galat koneksi di generator: $net0 → $net1, 503: $s0 → $s1"
            check "kill -9 Client API berefek (galat koneksi/503 di generator naik: $net0→$net1, $s0→$s1)" test $(( net1 + s1 )) -gt $(( net0 + s0 ))
            ;;
        kill_consumer)
            show "docker kill -s KILL $(cname "$PROC_C")"
            docker kill -s KILL "$PROC_C" >/dev/null
            wait_until 'lag > 0 selama consumer mati' 30 lag_positive || true
            lag=$(group_lag)
            info "lag saat consumer mati: $lag"
            check "kill -9 consumer berefek (lag=$lag > 0)" test "$lag" -gt 0
            show "docker start $(cname "$PROC_C")"
            docker start "$PROC_C" >/dev/null
            wait_until 'consumer tergabung lagi' 120 proc_ready || true
            ;;
        stop_aggregator)
            e0=$(proc_metric 'bnpb_field_report_processor_store_errors_total\{[^}]*kind="transient"[^}]*\}'); a0=$(num accepted)
            show "${compose[*]} stop bnpb-aggregator   (±15 s)"
            "${compose[@]}" stop bnpb-aggregator >/dev/null
            sleep 15
            e1=$(proc_metric 'bnpb_field_report_processor_store_errors_total\{[^}]*kind="transient"[^}]*\}'); a1=$(num accepted); lag=$(group_lag)
            info "store_errors transient: $e0 → $e1, lag=$lag, 202 selama Aggregator mati: $(( a1 - a0 ))"
            check "Aggregator mati berefek (store_errors $e0→$e1, lag=$lag)" bash -c "(( $e1 > $e0 || $lag > 0 ))"
            check "202 tetap dibalas selama hilir mati ($(( a1 - a0 )) balasan)" test $(( a1 - a0 )) -gt 0
            show "${compose[*]} start bnpb-aggregator"
            "${compose[@]}" start bnpb-aggregator >/dev/null
            wait_until 'Aggregator siap lagi' 180 entry_ready || true
            ;;
    esac
done

bold '3. Tunggu beban selesai, lalu lag = 0 (ground truth: kafka-consumer-groups)'
load_done() { [[ $(progress done) == true ]]; }
wait_until 'generator selesai' 600 load_done || true
docker logs "$LOAD_NAME" > "$OUT/load.log" 2>&1 || true
check 'generator selesai' load_done
wait_until 'lag consumer group = 0' 600 lag_zero || true
describe_group | tee "$OUT/consumer-group.txt" | sed 's/^/   /'
check 'lag = 0 sebelum verifikasi (celah "verifikasi sebelum consumer mengejar")' lag_zero

bold '4. Verifikasi isi store lewat Aggregator'
set +e
runner --rm -e GATEWAY_URL="http://bnpb-aggregator-entry:$(envval BNPB_AGGREGATOR_CONTAINER_PORT)" \
    -e INTERNAL_KEY="$(envval BNPB_AGGREGATOR_INTERNAL_API_KEY)" -- node /work/lib/load-field-reports.mjs verify > "$OUT/verify.log" 2>&1
verified=$?
set -e
node -e '
    const rd = (n) => JSON.parse(require("fs").readFileSync(process.argv[1] + n, "utf8")), v = rd("/verify.json"), l = rd("/load-summary.json");
    const lines = [
        `202 diterima: ${l.accepted_202} (id unik ${v.accepted_ids}), tersimpan: ${v.stored}, hilang: ${v.missing}, ganda: ${v.duplicated}, isi beda: ${v.mismatched}, fantom: ${v.phantoms}`,
        `tersimpan tanpa 202: ${v.stored_without_202}; dokumen terkirim ulang (deliveries>1): ${v.redelivered_docs}, deliveries maks: ${v.max_deliveries}`,
        `konflik: ${v.conflict_ids} id, ${v.conflict_202} kiriman konflik berbalas 202, entri DLQ conflict: ${v.dlq_conflicts}, total entri DLQ FIELD_REPORT: ${v.dlq_entries}`,
        `latensi 202 (ms): p50=${l.latency_ms.p50} p95=${l.latency_ms.p95} p99=${l.latency_ms.p99} max=${l.latency_ms.max}`,
        `status: ${JSON.stringify(l.status)}, galat koneksi: ${l.network_errors}, retry setelah gagal: ${l.retries_after_failure}, kiriman ulang sengaja: ${l.intentional_resends}, menyerah: ${l.gave_up}`,
        `token: login ${l.logins}, refresh ${l.refreshes}, 401 ${l.unauthorized}`,
        ...v.notes.map((n) => `catatan: ${n}`),
        ...v.problems.slice(0, 20).map((p) => `MASALAH: ${p}`),
    ];
    console.log(lines.map((x) => "   " + x).join("\n"));' "$OUT" | tee "$OUT/report.txt"
check 'setiap 202 tersimpan tepat sekali, isi = kiriman pertama, tanpa fantom, DLQ hanya konflik, tanpa partial' test "$verified" -eq 0
P95=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).latency_ms.p95)' "$OUT/load-summary.json")
# latency outside the Client API restart window (kill → ready + 5 s): what a client sees from a running instance
node -e '
    const fs = require("fs"), [dir] = process.argv.slice(1);
    const rows = fs.readFileSync(dir + "/accepted.ndjson", "utf8").trim().split("\n").map(JSON.parse);
    const win = fs.existsSync(dir + "/chaos.ndjson") ? fs.readFileSync(dir + "/chaos.ndjson", "utf8").trim().split("\n").map(JSON.parse) : [];
    const inWin = (t) => win.some((w) => t >= Date.parse(w.start) && t <= Date.parse(w.ready) + 5000);
    const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)] : null; };
    const steady = rows.filter((r) => !inWin(Date.parse(r.t))).map((r) => r.latency_ms);
    const restart = rows.filter((r) => inWin(Date.parse(r.t))).map((r) => r.latency_ms);
    const out = { steady: { n: steady.length, p50: pct(steady, 50), p95: pct(steady, 95), p99: pct(steady, 99) },
                  restart_window: { n: restart.length, p50: pct(restart, 50), p95: pct(restart, 95), p99: pct(restart, 99) } };
    fs.writeFileSync(dir + "/latency-split.json", JSON.stringify(out, null, 2));
    console.log(`   latensi 202 di luar jendela restart Client API: n=${out.steady.n} p50=${out.steady.p50} p95=${out.steady.p95} p99=${out.steady.p99} ms`);
    console.log(`   latensi 202 di jendela restart (kill → siap + 5 s): n=${out.restart_window.n} p50=${out.restart_window.p50} p95=${out.restart_window.p95} p99=${out.restart_window.p99} ms`);' "$OUT" | tee -a "$OUT/report.txt"
P95_STEADY=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).steady.p95)' "$OUT/latency-split.json")
check 'token di-refresh selama beban (TTL 60 s)' test "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).refreshes)' "$OUT/load-summary.json")" -ge 1
TARGET=$(node -e 'process.stdout.write(Number(process.argv[1]) < 200 ? "tercapai" : "TIDAK tercapai")' "$P95")
info "target p95 < 200 ms: $TARGET (p95 = $P95 ms)"

{
    summary
    echo "target p95 202 < 200 ms: $TARGET (p95 = $P95 ms seluruh beban termasuk restart Client API; p95 di luar jendela restart = $P95_STEADY ms)"
    echo '== Celah "lolos padahal hilang" dan penutupnya =='
    echo '  202 hanya di memori           → setiap 202 di-appendFileSync ke accepted.ndjson sebelum diproses lebih lanjut'
    echo '  verifikasi sebelum lag 0      → tunggu lag = 0 dari kafka-consumer-groups (broker), bukan metrik consumer'
    echo '  partial read                  → respons non-200 atau partial=true membuat verifikasi FAIL'
    echo '  chaos tanpa efek              → setiap gangguan di-assert (galat koneksi, lag > 0, store_errors naik)'
    echo '  DLQ menelan laporan           → entri DLQ selain konflik yang diharapkan = FAIL; konflik berbalas 202 wajib ada di DLQ'
    echo '  retensi topic                 → retention.ms=2592000000 diperiksa dengan kafka-configs'
} | tee "$OUT/result.txt"
info "artefak: $OUT"
(( ${#CHECKS_FAIL[@]} == 0 ))
