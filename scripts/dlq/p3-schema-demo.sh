#!/usr/bin/env bash
# Demo P3 #1–#5 (Tahap 4) di Compose: project terisolasi bnpb-p3, nilai demo .env.example.
# Langkah: normal → rename_field → type_change + missing_required → 4 jenis malformed → 2 node shard non-primary mati
#          → mapping m2-adjusted (salinan di test-results/) → replay lewat Client API → audit bersih, count/checksum stabil.
# Pemakaian (Git Bash, root repo): bash scripts/dlq/p3-schema-demo.sh [--no-pause] [--keep]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
PAUSE=1
KEEP=0
for arg in "$@"; do
    case "$arg" in
        --no-pause) PAUSE=0 ;;
        --keep) KEEP=1 ;;
        *) echo "Argumen tidak dikenal: $arg" >&2; exit 2 ;;
    esac
done

export COMPOSE_PROJECT_NAME=bnpb-p3
# shellcheck source=lib/p3-stack.sh
source scripts/dlq/lib/p3-stack.sh
OUT="test-results/p3-schema/$(date +%Y%m%dT%H%M%S)"
mkdir -p "$OUT/mapping"
# the Aggregator mounts a COPY of the mapping directory; the tracked file is never edited (D-36)
cp services/bnpb-aggregator/config/pvmbg-mapping/mapping.json "$OUT/mapping/mapping.json"
export BNPB_AGGREGATOR_PVMBG_MAPPING_DIR="./$OUT/mapping"
p3_override "$OUT"
exec > >(tee "$OUT/demo.log") 2>&1

pause() {
    [[ $PAUSE == 1 ]] || return 0
    read -r -p '   [Enter] untuk lanjut ' _ </dev/tty || true
}
cleanup() {
    local code=$?
    "${compose[@]}" start canonical-shard-a-2 canonical-shard-a-3 canonical-shard-b-2 canonical-shard-b-3 >/dev/null 2>&1 || true
    "${compose[@]}" logs --no-color bnpb-aggregator pvmbg bnpb-client-api > "$OUT/compose.log" 2>&1 || true
    if [[ $KEEP == 0 ]]; then "${compose[@]}" --profile test down -v --remove-orphans >/dev/null 2>&1 || true; fi
    exit "$code"
}
trap cleanup EXIT

AUDIT_PVMBG='/internal/audit/unprocessed?source=PVMBG&limit=1000'
audit_pvmbg() { agg1 GET "$AUDIT_PVMBG" audit; }
checksum() { agg1 GET "/internal/audit/checksum?source=$1" audit | jget checksum; }
count_source() { mongo_eval "db.hazard_events.countDocuments({source:'$1'})"; }
state() { mongo_eval 'JSON.stringify(db.source_sync_states.findOne({_id:"PVMBG_VOLCANIC"}))'; }
body_failures() { local v; v=$(state | jget consecutiveBodyFailures); echo "${v:-0}"; }
# items of the PVMBG audit page matching a JS predicate on item `i`: audit_where '<expr>' [field]
audit_where() {
    audit_pvmbg | node -e '
        let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ const j=JSON.parse(s||"{}"); const f=new Function("i","return "+process.argv[1]);
            const items=(j.items||[]).filter(f); console.log(process.argv[2]==="count"?items.length:JSON.stringify(items.slice(0,3),null,0)); });' "$1" "${2:-count}"
}
# distinct reasons in the PVMBG audit page with their counts
reasons() {
    audit_pvmbg | node -e '
        let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ const j=JSON.parse(s||"{}"); const m=new Map();
            for (const i of j.items||[]) { const k=`${i.status} retryable=${i.retryable} ${i.reason}`; m.set(k,(m.get(k)||0)+1); }
            for (const [k,v] of [...m].sort()) console.log(`   ${String(v).padStart(4)} × ${k}`);
            console.log(`   partial=${j.partial} unavailable_units=${JSON.stringify(j.unavailable_units||[])}`); });'
}
set_mode() { show "POST /admin/schema-version {\"mode\":\"$1\"}"; info "→ $(mock POST /admin/schema-version "{\"mode\":\"$1\"}")"; }
replicas_hash() { local c; for c in $(containers bnpb-aggregator); do agg "$c" GET /internal/pvmbg/mapping | jget hash; done | sort -u; }
restart_snapshot() { local c; for c in $(containers bnpb-aggregator) $(containers pvmbg); do echo "$(cname "$c") $(restarts "$c")"; done | sort; }
# Lampiran A checksum computed from the mock's own database (sha256 of sorted ids, byte order, "\n" separated, no trailing newline)
mock_checksum() {
    mock_sql 'SELECT report_id FROM volcanic_reports' | LC_ALL=C sort | node -e '
        let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ const ids=s.split("\n").filter(Boolean);
            process.stdout.write(require("crypto").createHash("sha256").update(ids.join("\n")).digest("hex")); });'
}
expect_reason() {
    local expected=$1 n
    n=$(audit_where "i.reason===$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$expected")")
    check "reason persis SCHEMA_POLICY ($n entri): $expected" test "$n" -ge 1
}

bold "0. Persiapan: stack terisolasi $COMPOSE_PROJECT_NAME, mapping = salinan di $OUT/mapping"
show "${compose[*]} up -d bnpb-client-api pvmbg bmkg"
stack_up bnpb-client-api pvmbg bmkg
wait_until 'leader Aggregator terpilih' 240 has_leader
api_ready() { [[ $(api GET /health/ready '' | cut -d' ' -f1) == 200 ]]; }
wait_until 'Client API siap' 180 api_ready
show "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME bash scripts/seed-users.sh"
COMPOSE_ENV_FILES="$ENV_FILE" bash scripts/seed-users.sh | sed 's/^/   /'
polled() { (( $(count_source PVMBG) >= 3 && $(count_source BMKG) >= 1 )); }
wait_until 'HazardEvent PVMBG dan BMKG pertama tersimpan' 180 polled
info "replica Aggregator: $(for c in $(containers bnpb-aggregator); do printf '%s ' "$(cname "$c")"; done)"
RESTARTS_START=$(restart_snapshot)

bold '1. Kondisi normal (v1 lalu v2_confidence aditif: diterima otomatis)'
set_mode v2_confidence
has_v2() { (( $(mongo_eval "db.hazard_events.countDocuments({source:'PVMBG','attributes.confidence_level':{\$type:'number'}})") >= 1 )); }
wait_until 'record v2 (confidence_level) tersimpan' 120 has_v2 || true
check 'field aditif confidence_level diterima otomatis' has_v2
info "PVMBG count=$(count_source PVMBG) checksum=$(checksum PVMBG)"
info "BMKG  count=$(count_source BMKG)"
info "dengan confidence_level: $(mongo_eval "db.hazard_events.countDocuments({source:'PVMBG','attributes.confidence_level':{\$exists:true}})")"
# {field:null} also matches a missing field (every v1 record); $type:'null' counts stored nulls only (PLAN 4.0)
NULL_OR_MISSING=$(mongo_eval "db.hazard_events.countDocuments({source:'PVMBG','attributes.confidence_level':null})")
NULL_STORED=$(mongo_eval "db.hazard_events.countDocuments({source:'PVMBG','attributes.confidence_level':{\$type:'null'}})")
show "db.hazard_events.countDocuments({source:'PVMBG','attributes.confidence_level':null}) → $NULL_OR_MISSING (null ATAU tidak ada)"
show "db.hazard_events.countDocuments({source:'PVMBG','attributes.confidence_level':{\$type:'null'}}) → $NULL_STORED (null tersimpan)"
echo "null_or_missing=$NULL_OR_MISSING null_stored=$NULL_STORED" > "$OUT/confidence-null.txt"
check 'tidak ada confidence_level null tersimpan (keputusan validator 4.2a)' test "$NULL_STORED" -eq 0
show "GET $AUDIT_PVMBG (token audit)"
reasons
# transient store errors (retrying) can happen on a loaded host and are retried; the schema policy is about permanent ones
info "entri retrying (sementara, dicoba ulang otomatis): $(audit_where 'i.retryable===true')"
check 'tidak ada kegagalan permanen (skema/validasi) untuk v1 + v2_confidence aditif' test "$(audit_where 'i.retryable===false')" -eq 0
pause

bold '2. rename_field: alert_level → level (parked schema_incompatible, BMKG tetap normal)'
BMKG0=$(count_source BMKG)
set_mode rename_field
has_rename() { (( $(audit_where "i.reason.includes(\"di-rename menjadi 'level'\")") >= 1 )); }
wait_until 'entri rename parked muncul di audit' 90 has_rename
show "GET $AUDIT_PVMBG"
reasons
info "contoh: $(audit_where "i.reason.includes('di-rename')" items)"
expect_reason "schema_incompatible: field wajib 'alert_level' hilang (kemungkinan di-rename menjadi 'level')"
check 'entri rename parked dan retryable=false' test "$(audit_where "i.reason.includes('di-rename') && (i.status!=='parked' || i.retryable!==false)")" -eq 0
sleep 4
BMKG1=$(count_source BMKG)
check "BMKG tetap diproses ($BMKG0 → $BMKG1)" test "$BMKG1" -gt "$BMKG0"
pause

bold '3. type_change dan missing_required'
set_mode type_change
has_type() { (( $(audit_where "i.reason.includes('menjadi number')") >= 1 )); }
wait_until 'entri type_change muncul' 90 has_type
expect_reason "schema_incompatible: field 'alert_level' berubah dari string (enum Normal|Waspada|Siaga|Awas) menjadi number"
set_mode missing_required
has_missing() { (( $(audit_where "i.reason.includes(\"'eruption_count_24h' hilang\")") >= 1 )); }
wait_until 'entri missing_required muncul' 90 has_missing
expect_reason "schema_incompatible: field wajib 'eruption_count_24h' hilang"
set_mode v2_confidence
reasons
SCHEMA_PARKED=$(audit_where "i.reason.startsWith('schema_incompatible')")
info "entri schema_incompatible parked: $SCHEMA_PARKED"
pause

bold '4. Empat jenis pesan rusak: tidak ada crash/restart, poll lain tetap jalan'
BMKG0=$(count_source BMKG)
R4=$(restart_snapshot)
bodies=()
for kind in truncated deep_nesting invalid_utf8 oversized; do
    show "POST /admin/malformed {\"kind\":\"$kind\",\"count\":1}"
    bodies+=("{\"kind\":\"$kind\",\"count\":1}")
done
mock_post_all /admin/malformed "${bodies[@]}" >/dev/null
drained() { [[ $(mock GET /admin/malformed | jget pending) == '[]' ]] && (( $(body_failures) == 0 )); }
peak_mem=''
watch_mem() { peak_mem=$(docker stats --no-stream --format '{{.MemUsage}}' "$(first pvmbg)"); drained; }
wait_until 'antrean malformed habis dan poll PVMBG pulih' 180 watch_mem
show "docker stats --no-stream $(cname "$(first pvmbg)")"
docker stats --no-stream --format '   {{.Name}} mem={{.MemUsage}} ({{.MemPerc}}) cpu={{.CPUPerc}}' "$(first pvmbg)" $(containers bnpb-aggregator)
show "docker inspect -f '{{.RestartCount}}' <aggregator…> <pvmbg>"
restart_snapshot | sed 's/^/   RestartCount /'
check 'RestartCount Aggregator dan mock tidak naik' test "$(restart_snapshot)" == "$R4"
for cat in malformed_json nesting_too_deep invalid_utf8 payload_too_large; do
    check "body $cat tersimpan parked" test "$(audit_where "i.reason.startsWith('$cat:') && i.status==='parked'")" -ge 1
done
BMKG1=$(count_source BMKG)
check "BMKG tetap diproses selama injeksi ($BMKG0 → $BMKG1)" test "$BMKG1" -gt "$BMKG0"
P0=$(count_source PVMBG); sleep 6; P1=$(count_source PVMBG)
check "poll PVMBG berlanjut setelah body rusak ($P0 → $P1)" test "$P1" -gt "$P0"
pause

bold '5. Dua node shard NON-primary dimatikan → entri retrying pulih sendiri; entri schema tetap parked'
PRIMARY=$(mongo_eval "db.getSiblingDB('config').databases.findOne({_id:db.getName()}).primary")
# shard holding one document (hashed _id); unsharded collections (the lease) live on the primary shard
doc_shard() { mongo_eval "JSON.stringify(db.getCollection('$1').find({_id:'$2'}).explain()).match(/\"shardName\":\"(canonical-shard-[ab])\"/)[1]"; }
SYNC_SHARD=$(doc_shard source_sync_states PVMBG_VOLCANIC)
SEQ_SHARD=$(doc_shard ordering_sequences PVMBG:receive)
info "primary shard (config.databases, lease): $PRIMARY; source_sync_states PVMBG_VOLCANIC: $SYNC_SHARD; ordering_sequences PVMBG:receive: $SEQ_SHARD"
case "$PRIMARY" in
    canonical-shard-a) VICTIM=b ;;
    canonical-shard-b) VICTIM=a ;;
    *) echo "primary shard tidak dikenal: $PRIMARY" >&2; exit 1 ;;
esac
CONTROL_ON_VICTIM=0
[[ $SYNC_SHARD == "canonical-shard-$VICTIM" || $SEQ_SHARD == "canonical-shard-$VICTIM" ]] && CONTROL_ON_VICTIM=1
(( CONTROL_ON_VICTIM == 1 )) && info "catatan: dokumen kontrol poll PVMBG ada di shard non-primary; poll akan gagal utuh (checkpoint ditahan) alih-alih menghasilkan entri retrying per record"
# checkpoint of the PVMBG poll; "unreachable" while the shard holding source_sync_states has no primary
cp_read() { mongo_eval 'try { const d = db.source_sync_states.findOne({_id:"PVMBG_VOLCANIC"}); print(JSON.stringify(d ? d.lastSuccessfulPollAt : null)) } catch (e) { print("unreachable") }' || echo unreachable; }
CP_BEFORE=$(cp_read)
show "config.databases: primary shard database = $PRIMARY → matikan 2 dari 3 node canonical-shard-$VICTIM"
show "${compose[*]} stop canonical-shard-$VICTIM-2 canonical-shard-$VICTIM-3"
"${compose[@]}" stop "canonical-shard-$VICTIM-2" "canonical-shard-$VICTIM-3" >/dev/null
has_retrying() { (( $(audit_where "i.status==='retrying' && i.retryable===true") >= 1 )); }
if (( CONTROL_ON_VICTIM == 0 )); then
    wait_until 'entri retrying (store_unavailable/timeout) muncul' 180 has_retrying || true
else
    sleep 60
fi
reasons
RETRYING=$(audit_where "i.status==='retrying'")
CP_DURING=$(cp_read)
info "entri retrying: $RETRYING; checkpoint PVMBG sebelum=$CP_BEFORE selama=$CP_DURING"
if (( CONTROL_ON_VICTIM == 0 )); then
    check "ada entri retrying selama shard $VICTIM tanpa mayoritas ($RETRYING)" test "$RETRYING" -ge 1
else
    check "gangguan berefek: entri retrying ($RETRYING) atau checkpoint PVMBG ditahan" bash -c "(( $RETRYING >= 1 )) || [[ '$CP_BEFORE' == '$CP_DURING' || '$CP_DURING' == unreachable ]]"
fi
show "${compose[*]} start canonical-shard-$VICTIM-2 canonical-shard-$VICTIM-3"
"${compose[@]}" start "canonical-shard-$VICTIM-2" "canonical-shard-$VICTIM-3" >/dev/null
no_retrying() { (( $(audit_where "i.status==='retrying'") == 0 )) && audit_pvmbg | grep -q '"partial":false'; }
wait_until 'semua entri retrying pulih sendiri (retry worker), audit tidak partial' 300 no_retrying || true
reasons
check 'entri retrying pulih tanpa replay (audit lengkap, partial=false)' no_retrying
cp_moved() { local v; v=$(cp_read); [[ $v != unreachable && $v != "$CP_DURING" && $v != "$CP_BEFORE" ]]; }
wait_until 'poll PVMBG sukses lagi setelah shard pulih' 180 cp_moved || true
check 'poll PVMBG pulih sendiri setelah shard kembali' cp_moved
check "entri schema_incompatible tetap parked ($SCHEMA_PARKED)" test "$(audit_where "i.reason.startsWith('schema_incompatible') && i.status==='parked'")" -eq "$SCHEMA_PARKED"
pause

bold '6. Penyesuaian sistem lewat config: mapping m2-adjusted (salinan, file ter-track tidak diubah)'
show "cp services/bnpb-aggregator/config/pvmbg-mapping/examples/m2-adjusted.json $OUT/mapping/mapping.json"
cp services/bnpb-aggregator/config/pvmbg-mapping/examples/m2-adjusted.json "$OUT/mapping/mapping.json"
WANT=$(sha256sum "$OUT/mapping/mapping.json" | cut -d' ' -f1)
info "sha256 file: $WANT"
all_replicas_hash() { [[ $(replicas_hash) == "$WANT" ]]; }
wait_until 'SEMUA replica melaporkan hash = sha256 file' 60 all_replicas_hash || true
for c in $(containers bnpb-aggregator); do
    info "$(cname "$c"): $(agg "$c" GET /internal/pvmbg/mapping | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(`hash=${j.hash} label=${j.label} source=${j.source} last_error=${j.last_error}`)})')"
done
check 'semua replica memakai mapping m2-adjusted' all_replicas_hash
git diff --quiet -- services/bnpb-aggregator/config && check 'file mapping yang di-track git tidak berubah' true
pause

bold '7. Replay lewat Client API (role internal); role lapangan/public → 403'
LAPANGAN=$(token lapangan@example.test)
PUBLIC=$(token public@example.test)
INTERNAL=$(token internal@example.test)
show 'POST /internal-ops/dlq/replay {"source":"PVMBG"}  (token lapangan)'
r=$(api POST /internal-ops/dlq/replay "$LAPANGAN" '{"source":"PVMBG"}'); info "→ $r"
check 'lapangan → 403 forbidden' test "${r%% *}" == 403
r=$(api GET '/internal-ops/dlq?source=PVMBG&limit=1' "$PUBLIC"); info "GET /internal-ops/dlq (public) → ${r:0:160}"
check 'public tidak bisa memeriksa DLQ (403)' test "${r%% *}" == 403
r=$(api GET '/internal-ops/dlq?source=PVMBG&limit=1' "$LAPANGAN"); info "GET /internal-ops/dlq (lapangan) → ${r:0:160}"
check 'lapangan tidak bisa memeriksa DLQ (403)' test "${r%% *}" == 403
show 'POST /internal-ops/dlq/replay {"source":"PVMBG"}  (token internal)'
r=$(api POST /internal-ops/dlq/replay "$INTERNAL" '{"source":"PVMBG"}'); info "→ $r"
echo "$r" > "$OUT/replay-1.txt"
check 'internal → 200 dan ada entri yang di-requeue' bash -c "[[ '${r%% *}' == 200 ]] && (( \$(echo '${r#* }' | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>console.log(JSON.parse(s).requeued))') >= 1 ))"
schema_gone() { (( $(audit_where "i.reason.startsWith('schema_incompatible')") == 0 )) && (( $(audit_where "i.status==='retrying'") == 0 )); }
wait_until 'entri schema pulih (hilang dari audit)' 240 schema_gone || true
reasons
pause

bold '8. Audit bersih, replay kedua idempoten, checksum = DB mock'
check 'audit tidak lagi memuat entri schema_incompatible (semua pulih)' schema_gone
check 'sisa audit hanya byte rusak (pulih lewat poll ulang D-34, bukan replay)' test "$(audit_where "!/^(malformed_json|nesting_too_deep|invalid_utf8|payload_too_large):/.test(i.reason)")" -eq 0
C1=$(count_source PVMBG); S1=$(checksum PVMBG)
info "setelah replay 1: count=$C1 checksum=$S1"
# freeze the source so counts can be compared: recreate the mock with generation probability 0 (data stays in pvmbg-store)
cat > "$OUT/freeze-pvmbg.yml" <<'YAML'
services:
    pvmbg:
        environment:
            PVMBG_REPORT_GENERATION_PROBABILITY: 0
YAML
show "${compose[*]} -f $OUT/freeze-pvmbg.yml up -d pvmbg   (generator dihentikan, data tetap)"
"${compose[@]}" -f "$OUT/freeze-pvmbg.yml" up -d --no-deps pvmbg >/dev/null
mock_up() { [[ $(mock GET /health | jget status) != '' ]]; }
wait_until 'mock kembali sehat' 60 mock_up || true
settled() { local a b; a=$(count_source PVMBG); sleep 6; b=$(count_source PVMBG); [[ $a == "$b" ]] && (( $(body_failures) == 0 )); }
wait_until 'store PVMBG tidak bertambah lagi (semua record mock sudah ter-poll)' 120 settled || true
C1=$(count_source PVMBG); S1=$(checksum PVMBG)
info "beku: count=$C1 checksum=$S1"
# access tokens live 60 s: log in again right before the second replay
INTERNAL=$(token internal@example.test)
r=$(api POST /internal-ops/dlq/replay "$INTERNAL" '{"source":"PVMBG"}'); info "replay 2 → $r"
check 'replay kedua berjalan (HTTP 200)' test "${r%% *}" == 200
echo "$r" > "$OUT/replay-2.txt"
sleep 15
C2=$(count_source PVMBG); S2=$(checksum PVMBG)
info "setelah replay 2: count=$C2 checksum=$S2"
check 'replay dua kali: count sama (tanpa duplikat)' test "$C1" == "$C2"
check 'replay dua kali: checksum sama' test "$S1" == "$S2"
MOCK_COUNT=$(mock_sql 'SELECT count(*) FROM volcanic_reports')
MOCK_SUM=$(mock_checksum)
info "DB mock: count=$MOCK_COUNT checksum=$MOCK_SUM"
show "GET /internal/audit/checksum?source=PVMBG → $S2"
check 'checksum dari report_id DB mock = /internal/audit/checksum?source=PVMBG' test "$MOCK_SUM" == "$S2"
check 'count DB mock = count HazardEvent PVMBG' test "$MOCK_COUNT" == "$C2"
OUTBOX_DUP=$(mongo_eval "db.outbox_events.aggregate([{\$match:{source:'PVMBG'}},{\$group:{_id:{h:'\$hazardId',t:'\$changeType',c:'\$contentHash'},n:{\$sum:1}}},{\$match:{n:{\$gt:1}}},{\$count:'d'}]).toArray().length")
info "grup outbox ganda (heuristik): ${OUTBOX_DUP:-0}"
check 'RestartCount sepanjang demo tidak naik (mock dibuat ulang sengaja di langkah 8)' bash -c "diff <(echo '$RESTARTS_START' | grep -v pvmbg) <(echo '$(restart_snapshot)' | grep -v pvmbg) >/dev/null"
show "${compose[*]} --profile test run --rm canonical-store-tests node --test tests/integration/pvmbg-ordering.test.cjs"
set +e
"${compose[@]}" --profile test run --rm --build canonical-store-tests node --test tests/integration/pvmbg-ordering.test.cjs > "$OUT/pvmbg-ordering.log" 2>&1
ord=$?
set -e
grep -E '^# (pass|fail)|^(not )?ok ' "$OUT/pvmbg-ordering.log" | sed 's/^/   /' | tail -12
check '"versi terbaru menang" per source_ref_id (pvmbg-ordering.test.cjs)' test "$ord" -eq 0

summary | tee "$OUT/result.txt"
info "artefak: $OUT"
(( ${#CHECKS_FAIL[@]} == 0 ))
