#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p test-results

k6 run \
    -e "CLIENT_API_BASE_URL=${CLIENT_API_BASE_URL:-http://localhost:3000}" \
    -e "AUTH_BASE_URL=${AUTH_BASE_URL:-http://localhost:3001}" \
    -e "VUS=${VUS:-50}" \
    -e "DURATION=${DURATION:-60s}" \
    -e "ITERATION_SLEEP_SECONDS=${ITERATION_SLEEP_SECONDS:-1}" \
    --summary-export test-results/k6-client-api-summary.json \
    tests/load/client-api.k6.js
