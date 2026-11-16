#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
[[ -f .env ]] || { echo 'Create root .env from .env.example first' >&2; exit 1; }
compose=(docker compose -p bnpb-sensor-e2e -f docker-compose.yml -f docker-compose.e2e.yml)
cleanup() {
    local status=$?
    if (( status != 0 )); then "${compose[@]}" logs --no-color --tail=80 bnpb-aggregator sensor-pantai >&2 || true; fi
    for container in $("${compose[@]}" ps -aq sensor-pantai); do docker unpause "$container" >/dev/null 2>&1 || true; done
    "${compose[@]}" down -v --remove-orphans
}
trap cleanup EXIT
cleanup
"${compose[@]}" up --build -d
"${compose[@]}" --profile test build canonical-store-tests sensor-tests e2e
"${compose[@]}" --profile test run --rm --no-deps canonical-store-tests
"${compose[@]}" --profile test run --rm --no-deps e2e
"${compose[@]}" --profile test run --rm --no-deps sensor-tests
