#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
if [[ ! -f .env ]]; then
    echo 'Missing .env. Create it with: cp .env.example .env' >&2
    exit 1
fi

export COMPOSE_PROJECT_NAME=bnpb-failover
compose=(docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.yml -f docker-compose.e2e.yml)

cleanup() {
    # Resume paused containers so cleanup also works after a failed freeze test.
    for container in $("${compose[@]}" ps -aq bnpb-aggregator); do
        docker unpause "$container" >/dev/null 2>&1 || true
    done
    "${compose[@]}" down -v --remove-orphans
}
trap cleanup EXIT
cleanup
"${compose[@]}" up --build -d
"${compose[@]}" --profile test build e2e failover-tests
"${compose[@]}" --profile test run --rm --no-deps e2e
"${compose[@]}" --profile test run --rm --no-deps failover-tests
