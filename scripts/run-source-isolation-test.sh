#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

env_value() {
    grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true
}

pvmbg_port="$(env_value PVMBG_PORT)"

mkdir -p test-results

k6 run \
    -e "CLIENT_API_BASE_URL=${CLIENT_API_BASE_URL:-http://localhost:3000}" \
    -e "AUTH_BASE_URL=${AUTH_BASE_URL:-http://localhost:3001}" \
    -e "PVMBG_BASE_URL=${PVMBG_BASE_URL:-http://localhost:${pvmbg_port:-8082}}" \
    -e "PVMBG_TOKEN=${PVMBG_TOKEN:-$(env_value BNPB_AGGREGATOR_PVMBG_TOKEN)}" \
    -e "MIN_PVMBG_DELAY_MS=${MIN_PVMBG_DELAY_MS:-2500}" \
    -e "VUS_PER_SCENARIO=${VUS_PER_SCENARIO:-25}" \
    -e "DURATION=${DURATION:-60s}" \
    -e "ITERATION_SLEEP_SECONDS=${ITERATION_SLEEP_SECONDS:-0.5}" \
    --summary-export test-results/k6-source-isolation-summary.json \
    tests/load/source-isolation.k6.js
