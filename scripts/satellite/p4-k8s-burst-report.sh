#!/usr/bin/env bash
# P4 #4 di K8s (feed asli 60×): p95 end-to-end, puncak ketertinggalan, dan waktu pulih dari Prometheus cluster, plus cek celah/duplikat satellite.raw.
# Hanya mengukur: tidak pernah membuka koneksi ke feed dan tidak pernah memanggil /v1/exam/start atau /v1/video.
# Pemakaian (Git Bash, root repo, KUBE_CONTEXT wajib):
#   bash scripts/satellite/p4-k8s-burst-report.sh                                            # interaktif: mulai sekarang, Enter saat lonjakan selesai
#   bash scripts/satellite/p4-k8s-burst-report.sh --start <ISO> --burst-end <ISO> [--end <ISO>]  # setelah sesi (selama pod Prometheus belum restart)
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
START='' BURST_END='' END=''
while (( $# )); do
    case "$1" in
        --start) START=${2:?--start butuh waktu ISO}; shift 2 ;;
        --burst-end) BURST_END=${2:?--burst-end butuh waktu ISO}; shift 2 ;;
        --end) END=${2:?--end butuh waktu ISO}; shift 2 ;;
        *) echo "Argumen tidak dikenal: $1" >&2; exit 2 ;;
    esac
done
if [[ -n $START && -z $BURST_END ]] || [[ -z $START && -n $BURST_END$END ]]; then
    echo 'Mode setelah sesi butuh --start dan --burst-end (opsional --end).' >&2
    exit 2
fi
: "${KUBE_CONTEXT:?set KUBE_CONTEXT dulu, mis. export KUBE_CONTEXT=bnpb-demo}"
NS=${P4_NS:-sistem-informasi-kebencanaan-bnpb}
KC=(kubectl --context "$KUBE_CONTEXT" -n "$NS")
PROM_PORT=${P4_PROM_LOCAL_PORT:-19090}
PROM=http://localhost:$PROM_PORT
CATCHUP_WAIT_S=${P4_CATCHUP_WAIT_S:-300}
OUT="test-results/p4-burst/$(date +%Y%m%dT%H%M%S)-k8s"
mkdir -p "$OUT"

bold() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
# GET di dalam pod (internal key / audit token dari env pod itu)
inside() {
    "${KC[@]}" exec "$1" -- node -e '
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
agg_pods() { "${KC[@]}" get pods -l app=bnpb-aggregator --field-selector=status.phase=Running -o name; }
sat_status() { inside "$1" http://localhost:3000/internal/satellite/status internal; }
# status replica pemegang stream (leader + connected); kosong kalau tidak ada
leader_status() {
    local p s
    for p in $(agg_pods); do
        s=$(sat_status "$p")
        [[ $(echo "$s" | jget leader) == true && $(echo "$s" | jget connected) == true ]] && { echo "$s"; return 0; }
    done
    echo '{}'
}
fire_offset() { inside deploy/fire-processor http://localhost:3000/status | jget last_offset; }
caught_up() {
    local s latest lag fire
    s=$(leader_status); latest=$(echo "$s" | jget latest_offset); lag=$(echo "$s" | jget lag_offsets); fire=$(fire_offset)
    [[ -n $latest && -n $lag && -n $fire ]] && (( lag <= 1 && fire >= latest - 1 ))
}
wait_until() {
    local description=$1 timeout=$2; shift 2
    local start=$SECONDS
    until "$@"; do
        if (( SECONDS - start > timeout )); then info "TIMEOUT (${timeout}s): $description"; return 1; fi
        sleep 2
    done
}

# Git Bash: kill saja tidak selalu menghentikan proses Windows (kubectl.exe), jadi pohon prosesnya di-taskkill
kill_tree() {
    if [[ -r /proc/$1/winpid ]] && command -v taskkill >/dev/null 2>&1; then
        MSYS_NO_PATHCONV=1 taskkill /F /T /PID "$(cat "/proc/$1/winpid")" >/dev/null 2>&1 || true
    fi
    kill "$1" 2>/dev/null || true
}
PF=''
trap '[[ -z $PF ]] || kill_tree "$PF"' EXIT
exec > >(tee "$OUT/run.log") 2>&1

bold "1. Prometheus cluster (context $KUBE_CONTEXT, namespace $NS)"
if ! "${KC[@]}" rollout status deploy/prometheus --timeout=60s >/dev/null 2>&1; then
    echo 'Prometheus belum ada/siap di cluster: deploy ulang dengan "observability": true (scripts/kubernetes/deploy-all.sh).' >&2
    exit 2
fi
"${KC[@]}" port-forward svc/prometheus "$PROM_PORT:9090" > "$OUT/port-forward.log" 2>&1 &
PF=$!
ready=0
for _ in $(seq 1 30); do
    if curl -sf "$PROM/-/ready" >/dev/null; then ready=1; break; fi
    sleep 1
done
(( ready )) || { echo "port-forward Prometheus gagal (lihat $OUT/port-forward.log; port $PROM_PORT terpakai?)" >&2; exit 2; }
info "Prometheus: $PROM (port-forward pid $PF)"

if [[ -z $START ]]; then
    bold '2. Lonjakan (interaktif)'
    START=$(now)
    info "mulai $START; sesi 60× dijalankan asisten/penguji, bukan skrip ini"
    info "selama menunggu: Grafana → BNPB Overview → panel P4 (rekam/screenshot)"
    read -r -p '   Tekan Enter saat lonjakan 60× selesai ' _
    BURST_END=$(now)
    info "lonjakan selesai $BURST_END; fire processor di offset $(fire_offset)"
fi

if [[ -z $END ]]; then
    bold '3. Tunggu sistem mutakhir'
    wait_until "ingest lag <= 1 dan fire processor = latest_offset feed" "$CATCHUP_WAIT_S" caught_up || true
    info "mutakhir pada $(now); fire processor offset $(fire_offset)"
    sleep 20 # dua kali scrape interval supaya titik terakhir ada di Prometheus
    END=$(now)
fi
# query_range step 1 s: Prometheus menolak > 11000 titik per seri
if ! node -e 'const [a, b] = process.argv.slice(1).map(Date.parse); process.exit(Number.isFinite(a) && Number.isFinite(b) && (b - a) / 1000 <= 10800 ? 0 : 1)' "$START" "$END"; then
    echo "Jendela $START .. $END tidak valid atau > 3 jam: beri --end yang lebih dekat." >&2
    exit 2
fi

bold '4. Bukti'
inside deploy/fire-processor http://localhost:3000/status > "$OUT/fire-status.json"
: > "$OUT/status.ndjson"
for p in $(agg_pods); do sat_status "$p" >> "$OUT/status.ndjson"; echo >> "$OUT/status.ndjson"; done
LATEST=$(leader_status | jget latest_offset)
inside "$(agg_pods | head -1)" 'http://localhost:3000/internal/audit/unprocessed?source=SATELIT&limit=1000' audit > "$OUT/audit-unprocessed.json"
"${KC[@]}" exec statefulset/kafka -- kafka-console-consumer --bootstrap-server localhost:29092 --topic satellite.raw \
    --from-beginning --isolation-level read_committed --property print.key=true --property key.separator='|' \
    --timeout-ms 15000 > "$OUT/satellite-raw.txt" 2> "$OUT/consumer.err" || true
verify=(node scripts/satellite/lib/verify-satellite-raw.mjs --raw "$OUT/satellite-raw.txt" --audit "$OUT/audit-unprocessed.json" --status "$OUT/status.ndjson")
[[ -z $LATEST ]] || verify+=(--latest "$LATEST")
set +e
"${verify[@]}" > "$OUT/verify-raw.txt"
raw_ok=$?
node scripts/satellite/p4-lag-report.mjs --start "$START" --burst-end "$BURST_END" --end "$END" --prometheus "$PROM" --out "$OUT/lag-report.txt"
lag_ok=$?
set -e

fire_last=$(jget last_offset < "$OUT/fire-status.json")
{
    echo '== Pemeriksaan (K8s, feed asli) =='
    sed 's/^/  /' "$OUT/verify-raw.txt"
    echo "  fire processor last_offset ${fire_last:--} (latest_offset feed ${LATEST:--})"
    echo "  lonjakan $START .. $BURST_END, jendela sampai $END"
    sed 's/^/  /' "$OUT/lag-report.txt"
    if (( raw_ok == 0 && lag_ok == 0 )) && [[ -n $fire_last && -n $LATEST ]] && (( fire_last >= LATEST - 1 )); then
        echo 'HASIL AKHIR: PASS'
    else
        echo 'HASIL AKHIR: FAIL'
    fi
} | tee "$OUT/result.txt"
info "artefak: $OUT"
grep -q 'HASIL AKHIR: PASS' "$OUT/result.txt"
