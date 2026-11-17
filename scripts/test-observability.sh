#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
[[ -f .env ]] || { echo 'Create .env first: cp .env.example .env' >&2; exit 1; }
export PROMETHEUS_HOST_PORT=0 TEMPO_HOST_PORT=0 GRAFANA_HOST_PORT=0
export OTEL_SDK_DISABLED=false OTEL_TRACES_SAMPLER_ARG=1

# Only this isolated project's volumes are removed.
compose=(docker compose -p bnpb-observability-test -f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.observability.yml)
cleanup() {
    result=$?
    if [[ "$result" != 0 ]]; then "${compose[@]}" logs --tail 60 bnpb-aggregator otel-collector tempo prometheus grafana; fi
    "${compose[@]}" down -v --remove-orphans
    exit "$result"
}
trap cleanup EXIT
"${compose[@]}" down -v --remove-orphans
"${compose[@]}" up --build -d
"${compose[@]}" --profile test build observability-tests
"${compose[@]}" --profile test run --rm --no-deps observability-tests
