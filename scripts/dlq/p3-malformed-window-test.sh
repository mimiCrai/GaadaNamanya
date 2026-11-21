#!/usr/bin/env bash
# P3 #3 + D-34 di Compose (PASS/FAIL), project terisolasi bnpb-p3m, nilai demo .env.example.
#   Skenario 1: 4 jenis body rusak berturut-turut (< K) → checkpoint ditahan; semua report_id di DB mock ⊆ hazard_events PVMBG.
#   Skenario 2: K body rusak → checkpoint dipaksa maju; entri window_skipped dengan jendela [since, until) yang benar di DLQ.
# Pemakaian (Git Bash, root repo): bash scripts/dlq/p3-malformed-window-test.sh [--keep]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
KEEP=0
for arg in "$@"; do
    case "$arg" in
        --keep) KEEP=1 ;;
        *) echo "Argumen tidak dikenal: $arg" >&2; exit 2 ;;
    esac
done

export COMPOSE_PROJECT_NAME=bnpb-p3m
K=${P3_HOLD_POLLS:-5}
export BNPB_AGGREGATOR_PVMBG_BODY_FAILURE_HOLD_POLLS=$K
# shellcheck source=lib/p3-stack.sh
source scripts/dlq/lib/p3-stack.sh
OUT="test-results/p3-malformed/$(date +%Y%m%dT%H%M%S)"
mkdir -p "$OUT"
p3_override "$OUT"
exec > >(tee "$OUT/run.log") 2>&1

cleanup() {
    local code=$?
    "${compose[@]}" logs --no-color bnpb-aggregator pvmbg > "$OUT/compose.log" 2>&1 || true
    if [[ $KEEP == 0 ]]; then "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi
    exit "$code"
}
trap cleanup EXIT

state() { mongo_eval 'JSON.stringify(db.source_sync_states.findOne({_id:"PVMBG_VOLCANIC"}))'; }
checkpoint() { state | jget lastSuccessfulPollAt; }
body_failures() { local v; v=$(state | jget consecutiveBodyFailures); echo "${v:-0}"; }
dlq_pvmbg() { agg1 GET '/internal/dlq?source=PVMBG&limit=1000'; }
count_source() { mongo_eval "db.hazard_events.countDocuments({source:'$1'})"; }
# sum of a metric over every replica (leadership may move during the run)
metric_all() { local c s=0; for c in $(containers bnpb-aggregator); do s=$(( s + $(metric "$c" "$1") )); done; echo "$s"; }
restart_snapshot() { local c; for c in $(containers bnpb-aggregator) $(containers pvmbg); do echo "$(cname "$c") $(restarts "$c")"; done | sort; }
queue_drained() { [[ $(mock GET /admin/malformed | jget pending) == '[]' ]]; }

bold "0. Naikkan stack terisolasi ($COMPOSE_PROJECT_NAME), K=$K"
stack_up bnpb-aggregator-entry pvmbg bmkg
wait_until 'leader terpilih' 240 has_leader
polled_once() { [[ -n $(checkpoint) ]]; }
wait_until 'poll PVMBG pertama sukses' 180 polled_once
info "leader: $(cname "$(leader)")  checkpoint PVMBG: $(checkpoint)"
RESTARTS_BEFORE=$(restart_snapshot)
BMKG_BEFORE=$(count_source BMKG)

bold "1. Skenario 1 — empat jenis body rusak berturut-turut (4 < K=$K, checkpoint harus ditahan)"
HELD0=$(metric_all 'bnpb_aggregator_pvmbg_body_failures_total\{[^}]*outcome="held"[^}]*\}')
bodies=()
for kind in truncated deep_nesting invalid_utf8 oversized; do
    show "POST /admin/malformed {\"kind\":\"$kind\",\"count\":1}"
    bodies+=("{\"kind\":\"$kind\",\"count\":1}")
done
info "antrean mock: $(mock_post_all /admin/malformed "${bodies[@]}" | cut -c1-300)"
held_seen() { (( $(body_failures) >= 1 )); }
wait_until 'body rusak pertama ditahan' 60 held_seen
L0=$(checkpoint)
# sample the checkpoint for as long as failures are being held: it must never move
samples=()
max_held=0
# one read per sample: counter and checkpoint must come from the same document version
while :; do
    s=$(state)
    n=$(jget consecutiveBodyFailures <<<"$s"); n=${n:-0}
    (( n > 0 )) || break
    (( n > max_held )) && max_held=$n
    samples+=("$(jget lastSuccessfulPollAt <<<"$s")")
    sleep 1
done
moved=0
for s in "${samples[@]}"; do [[ -z $s || $s == "$L0" ]] || moved=1; done
info "checkpoint yang ditahan: $L0; ${#samples[@]} sampel selama ditahan, consecutiveBodyFailures maks=$max_held"
check 'checkpoint tidak maju selama body rusak ditahan' test "$moved" -eq 0
check "keempat body rusak ditahan berturut-turut (maks counter = $max_held)" test "$max_held" -ge 4
wait_until 'antrean malformed habis' 120 queue_drained
recovered() { local cp; cp=$(checkpoint); [[ $cp != "$L0" && $(body_failures) == 0 ]]; }
wait_until 'poll sukses setelah body rusak (checkpoint maju, counter reset)' 120 recovered
L1=$(checkpoint)
info "checkpoint setelah pulih: $L1"
HELD1=$(metric_all 'bnpb_aggregator_pvmbg_body_failures_total\{[^}]*outcome="held"[^}]*\}')
check "metrik held naik ≥ 4 ($HELD0 → $HELD1)" test $(( HELD1 - HELD0 )) -ge 4
dlq_pvmbg > "$OUT/dlq-pvmbg-1.json"
categories=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log([...new Set(j.items.map(i=>i.category))].sort().join(","))' "$OUT/dlq-pvmbg-1.json")
info "kategori DLQ PVMBG: $categories"
for cat in malformed_json nesting_too_deep invalid_utf8 payload_too_large; do
    check "DLQ memuat body rusak kategori $cat (parked, utuh)" grep -q "$cat" <<<"$categories"
done
check 'tidak ada window_skipped di skenario 1' bash -c "! grep -q window_skipped <<<'$categories'"

# records created during the held window must still arrive: wait two more polls after recovery
sleep 6
CUT=$(node -e 'console.log(new Date(Date.parse(process.argv[1]) - 2000).toISOString())' "$L1")
mock_sql "SELECT report_id FROM volcanic_reports WHERE reported_at < '$CUT' ORDER BY 1" > "$OUT/mock-ids-1.txt"
mock_sql "SELECT count(*) FROM volcanic_reports WHERE reported_at >= '$L0' AND reported_at < '$CUT'" > "$OUT/mock-window-1.txt"
mongo_eval "db.hazard_events.distinct('sourceRefId',{source:'PVMBG'}).sort().join('\n')" | sort > "$OUT/store-ids-1.txt"
sort -o "$OUT/mock-ids-1.txt" "$OUT/mock-ids-1.txt"
missing=$(comm -23 "$OUT/mock-ids-1.txt" "$OUT/store-ids-1.txt" | wc -l | tr -d ' ')
info "report_id mock (reported_at < $CUT): $(wc -l < "$OUT/mock-ids-1.txt" | tr -d ' '), di jendela ditahan: $(cat "$OUT/mock-window-1.txt"), hilang dari store: $missing"
comm -23 "$OUT/mock-ids-1.txt" "$OUT/store-ids-1.txt" > "$OUT/missing-1.txt"
check 'jendela yang ditahan benar-benar berisi record (uji tidak kosong)' test "$(cat "$OUT/mock-window-1.txt")" -ge 1
check 'semua report_id di DB mock ⊆ hazard_events PVMBG' test "$missing" -eq 0

bold "2. Skenario 2 — K=$K body rusak berturut-turut (checkpoint dipaksa maju, jendela dicatat)"
SKIP0=$(metric_all 'bnpb_aggregator_pvmbg_skipped_windows_total')
show "POST /admin/malformed {\"kind\":\"truncated\",\"count\":$K}"
mock POST /admin/malformed "{\"kind\":\"truncated\",\"count\":$K}" >/dev/null
wait_until 'body rusak pertama ditahan' 60 held_seen
S=$(checkpoint)
info "checkpoint yang ditahan (= since jendela): $S"
window_entry() {
    dlq_pvmbg | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"{}");const e=(j.items||[]).find(i=>i.category==="window_skipped");if(!e)process.exit(1);console.log(e.message_id)})'
}
has_window() { window_entry >/dev/null; }
wait_until 'entri window_skipped muncul di DLQ' 180 has_window
WID=$(window_entry)
agg1 GET "/internal/dlq/$WID" > "$OUT/window-entry.json"
agg1 GET "/internal/dlq/$WID/raw" > "$OUT/window-raw.json"
info "entri: $(jget reason < "$OUT/window-entry.json")"
info "isi:   $(cat "$OUT/window-raw.json")"
W_SINCE=$(jget since < "$OUT/window-raw.json")
W_UNTIL=$(jget until < "$OUT/window-raw.json")
W_N=$(jget consecutive_body_failures < "$OUT/window-raw.json")
OVERLAP=$(envval BNPB_AGGREGATOR_POLL_OVERLAP_MS)
# since of the held polls = checkpoint − POLL_OVERLAP_MS (polling.service.ts)
since_matches() { node -e 'process.exit(Date.parse(process.argv[1])===Date.parse(process.argv[2])-Number(process.argv[3])?0:1)' "$W_SINCE" "$S" "$OVERLAP"; }
before() { node -e 'process.exit(Date.parse(process.argv[1])<=Date.parse(process.argv[2])?0:1)' "$1" "$2"; }
check "since jendela = checkpoint yang ditahan − POLL_OVERLAP_MS ($W_SINCE = $S − ${OVERLAP} ms)" since_matches
check "until jendela > since ($W_UNTIL)" bash -c "node -e 'process.exit(Date.parse(process.argv[1])>Date.parse(process.argv[2])?0:1)' '$W_UNTIL' '$W_SINCE'"
check "consecutive_body_failures = K ($W_N)" test "$W_N" == "$K"
check 'entri window_skipped parked, retryable=false' bash -c "grep -q '\"status\":\"parked\"' '$OUT/window-entry.json' && grep -q '\"retryable\":false' '$OUT/window-entry.json'"
advanced() { local cp; cp=$(checkpoint); [[ -n $cp ]] && before "$W_UNTIL" "$cp" && [[ $(body_failures) == 0 ]]; }
wait_until 'checkpoint ≥ until jendela dan counter reset' 60 advanced
info "checkpoint setelah dipaksa maju: $(checkpoint)"
check 'checkpoint maju melewati jendela' advanced
SKIP1=$(metric_all 'bnpb_aggregator_pvmbg_skipped_windows_total')
check "metrik skipped_windows naik ($SKIP0 → $SKIP1)" test "$SKIP1" -gt "$SKIP0"
"${compose[@]}" logs --no-color bnpb-aggregator 2>/dev/null | grep 'checkpoint forced forward' | tail -1 | cut -c1-400 | sed 's/^/   log: /' || true
mock_sql "SELECT count(*) FROM volcanic_reports WHERE reported_at >= '$W_SINCE' AND reported_at < '$W_UNTIL'" > "$OUT/mock-window-2.txt"
info "record mock di jendela yang dilewati: $(cat "$OUT/mock-window-2.txt") (dipulihkan manual dengan since=$W_SINCE; inilah alasan entri window_skipped)"

bold '3. Tidak ada crash/restart, sumber lain tetap diproses'
RESTARTS_AFTER=$(restart_snapshot)
echo "$RESTARTS_AFTER" | sed 's/^/   RestartCount /'
check 'RestartCount Aggregator dan mock tidak berubah' test "$RESTARTS_BEFORE" == "$RESTARTS_AFTER"
docker stats --no-stream --format '   {{.Name}} mem={{.MemUsage}} cpu={{.CPUPerc}}' $(containers pvmbg) $(containers bnpb-aggregator)
BMKG_AFTER=$(count_source BMKG)
check "BMKG tetap diproses ($BMKG_BEFORE → $BMKG_AFTER HazardEvent)" test "$BMKG_AFTER" -gt "$BMKG_BEFORE"

summary | tee "$OUT/result.txt"
info "artefak: $OUT"
(( ${#CHECKS_FAIL[@]} == 0 ))
