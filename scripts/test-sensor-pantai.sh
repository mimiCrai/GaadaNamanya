#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
[[ -f .env ]] || { echo 'Create root .env from .env.example first' >&2; exit 1; }
compose=(docker compose -p bnpb-sensor-e2e -f docker-compose.yml -f docker-compose.e2e.yml)
source "$ROOT_DIR/scripts/lib/test-summary.sh"
test_output=$(mktemp)

cleanup() {
    local status=${1:-0}
    if (( status != 0 )); then "${compose[@]}" logs --no-color --tail=80 bnpb-aggregator sensor-pantai >&2 || true; fi
    for container in $("${compose[@]}" ps -aq sensor-pantai); do docker unpause "$container" >/dev/null 2>&1 || true; done
    "${compose[@]}" down -v --remove-orphans
}

finish() {
    local status=$?
    if ! cleanup "$status" && (( status == 0 )); then
        status=1
    fi
    print_tap_summary 'P5 Sensor Pantai' "$status" "$test_output"
    rm -f -- "$test_output"
    exit "$status"
}
trap finish EXIT
cleanup
"${compose[@]}" up --build -d
"${compose[@]}" --profile test build canonical-store-tests sensor-tests e2e
"${compose[@]}" --profile test run --rm --no-deps canonical-store-tests
"${compose[@]}" --profile test run --rm --no-deps e2e
"${compose[@]}" --profile test run -T --rm --no-deps sensor-tests 2>&1 | tee "$test_output"
