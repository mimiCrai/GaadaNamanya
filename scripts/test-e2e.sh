#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
    echo "Missing .env. Create it first with: cp .env.example .env" >&2
    exit 1
fi

# The separate project name creates isolated containers, networks, and volumes.
# docker-compose.e2e.yml removes host port bindings, so this can run alongside
# the normal local stack.
compose=(docker compose -p bnpb-e2e -f docker-compose.yml -f docker-compose.e2e.yml)

# Building five TypeScript services concurrently can make Docker Desktop cancel
# build contexts on constrained machines. Callers can raise this if desired.
export COMPOSE_PARALLEL_LIMIT="${COMPOSE_PARALLEL_LIMIT:-1}"

cleanup() {
    "${compose[@]}" down -v --remove-orphans
}
trap cleanup EXIT

cleanup
"${compose[@]}" up --build -d
"${compose[@]}" --profile test run --build --rm e2e
