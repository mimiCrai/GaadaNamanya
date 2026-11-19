#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
[[ -f .env ]] || { echo 'Create .env from .env.example first' >&2; exit 1; }
compose=(docker compose -p bnpb-storage-e2e -f docker-compose.yml -f docker-compose.e2e.yml)
cleanup() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then "${compose[@]}" logs --no-color --tail=100 bnpb-aggregator dashboard-consumer >&2 || true; fi
  "${compose[@]}" down -v --remove-orphans || status=1
  exit "$status"
}
trap cleanup EXIT
"${compose[@]}" up --build -d
"${compose[@]}" --profile test build e2e
# This smoke flow also waits for the sources and canonical data needed by audit pagination.
"${compose[@]}" --profile test run --rm e2e
"${compose[@]}" --profile test run --rm --no-deps e2e node --test audit-storage.test.mjs
"${compose[@]}" stop canonical-shard-b-1 canonical-shard-b-2 canonical-shard-b-3
"${compose[@]}" --profile test run --rm --no-deps -e STORAGE_TEST_STAGE=outage e2e node --test audit-storage.test.mjs
"${compose[@]}" start canonical-shard-b-1 canonical-shard-b-2 canonical-shard-b-3
"${compose[@]}" --profile test run --rm --no-deps -e STORAGE_TEST_STAGE=recovery e2e node --test audit-storage.test.mjs
