#!/usr/bin/env bash
# P4 #5: the same stub feed processed twice, once clean and once with the fire processor killed (SIGKILL) while
# fires are being recognised; the stored WILDFIRE HazardEvents, checksum and counters must be identical.
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
export COMPOSE_PROJECT_NAME=bnpb-p4c
OUT="test-results/p4-crash/$(date +%Y%m%dT%H%M%S)"
mkdir -p "$OUT/clean" "$OUT/crash"
export P4_STUB_LAST_OFFSET=${P4_STUB_LAST_OFFSET:-900}
export P4_STUB_INTERVAL_MS=${P4_STUB_INTERVAL_MS:-60}
export P4_STUB_SPREAD_DEG=${P4_STUB_SPREAD_DEG:-0.06}
export P4_STUB_MALFORMED_OFFSETS=${P4_STUB_MALFORMED_OFFSETS:-133}

# small flush/snapshot intervals so kills land between snapshots, i.e. with unsaved state in memory
cat > "$OUT/p4-fire-override.yml" <<'YAML'
services:
    fire-processor:
        environment:
            NODE_ENV: production
            FIRE_FLUSH_MAX_RECORDS: '10'
            FIRE_SNAPSHOT_EVERY_RECORDS: '45'
            FIRE_SNAPSHOT_INTERVAL_MS: '3000'
            FIRE_BACKOFF_BASE_MS: '200'
            FIRE_BACKOFF_CAP_MS: '2000'
        depends_on:
            bnpb-aggregator-entry:
                condition: service_started
YAML
compose=(docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.e2e.yml
    -f docker-compose.satellite-test.yml -f "$OUT/p4-fire-override.yml")

bold() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
container() {
    docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
        --filter "label=com.docker.compose.service=$1" | head -1
}
# GET inside a container (internal key / audit token from that container's env)
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
fire_offset() {
    local c v
    c=$(container fire-processor)
    [[ -z $c ]] && { echo -1; return; }
    v=$(inside "$c" http://localhost:3000/status | jget last_offset)
    echo "${v:--1}"
}
wait_until() {
    local description=$1 timeout=$2
    shift 2
    local start=$SECONDS
    until "$@"; do
        if (( SECONDS - start > timeout )); then info "TIMEOUT (${timeout}s): $description"; return 1; fi
        sleep 1
    done
}
reached() { (( $(fire_offset) >= $1 )); }

stack_up() {
    "${compose[@]}" build bnpb-aggregator fire-processor satellite-stub >/dev/null
    for attempt in 1 2 3; do
        "${compose[@]}" up -d --wait canonical-store-init kafka-topic-init >/dev/null 2>&1 && break
        info "infra belum sehat (percobaan $attempt), ulangi"
    done
    "${compose[@]}" up -d bnpb-aggregator bnpb-aggregator-entry satellite-stub fire-processor >/dev/null
}
stack_down() { "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }

collect() {
    local dir=$1 agg cursor page
    agg=$(container bnpb-aggregator)
    inside "$agg" "http://localhost:3000/internal/audit/checksum?source=SATELIT" audit > "$dir/checksum.json"
    inside "$agg" "http://localhost:3000/internal/satellite/summary" internal > "$dir/summary.json"
    inside "$(container fire-processor)" http://localhost:3000/status > "$dir/status.json"
    echo '[]' > "$dir/events.json"
    cursor=''
    while :; do
        page=$(inside "$agg" "http://localhost:3000/internal/audit/events?source=SATELIT&limit=1000${cursor:+&cursor=$cursor}" audit)
        printf '%s' "$page" > "$dir/page.json"
        node -e '
            const fs = require("fs"); const [file, page] = process.argv.slice(1);
            const all = JSON.parse(fs.readFileSync(file, "utf8")); const body = JSON.parse(fs.readFileSync(page, "utf8"));
            if (body.partial) { console.error("partial read"); process.exit(3); }
            fs.writeFileSync(file, JSON.stringify(all.concat(body.items ?? []), null, 1));' "$dir/events.json" "$dir/page.json"
        cursor=$(jget next_cursor < "$dir/page.json")
        [[ -z $cursor ]] && break
    done
    rm -f "$dir/page.json"
    info "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).length)' "$dir/events.json") WILDFIRE, checksum $(jget checksum < "$dir/checksum.json")"
}

run() {
    local name=$1 kills=$2 last=$P4_STUB_LAST_OFFSET
    bold "Run $name"
    stack_down
    stack_up
    if (( kills > 0 )); then
        for fraction in 25 50 75; do
            local target=$(( last * fraction / 100 ))
            wait_until "fire processor offset >= $target" 600 reached "$target"
            info "SIGKILL fire-processor at offset $(fire_offset) (target $target)"
            docker kill -s KILL "$(container fire-processor)" >/dev/null
            sleep 2
            "${compose[@]}" start fire-processor >/dev/null
        done
    fi
    wait_until "fire processor reaches offset $last" 900 reached "$last"
    sleep 5 # final flush + stats
    collect "$OUT/$name"
    "${compose[@]}" logs --no-color fire-processor > "$OUT/$name/fire-processor.log" 2>&1 || true
}

trap '[[ $KEEP == 1 ]] || stack_down' EXIT
run clean 0
run crash 3
bold Perbandingan
node scripts/satellite/lib/compare-fire-runs.mjs "$OUT/clean" "$OUT/crash" "$OUT/result.txt"
