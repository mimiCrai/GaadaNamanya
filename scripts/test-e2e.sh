#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
    echo "Missing .env. Create it first with: cp .env.example .env" >&2
    exit 1
fi

# Isolated project plus the test-only override.
compose=(docker compose -p bnpb-e2e -f docker-compose.yml -f docker-compose.e2e.yml)

cleanup() {
    "${compose[@]}" down -v --remove-orphans
}
trap cleanup EXIT

cleanup
"${compose[@]}" up --build -d
"${compose[@]}" --profile test build e2e
"${compose[@]}" --profile test run --rm e2e
