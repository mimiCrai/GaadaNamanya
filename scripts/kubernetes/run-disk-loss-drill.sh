#!/usr/bin/env bash
set -euo pipefail
: "${KUBE_CONTEXT:?Set KUBE_CONTEXT explicitly}"
kubectl() { command kubectl --context "$KUBE_CONTEXT" "$@"; }

if [[ $# -ne 3 ]]; then
  echo 'Usage: run-disk-loss-drill.sh NAMESPACE canonical-config|canonical-shard-a|canonical-shard-b BASELINE_JSON' >&2
  exit 2
fi
root=$(cd "$(dirname "$0")/../.." && pwd)
bash "$(dirname "$0")/check-recovery.sh" before "$3"
bash "$(dirname "$0")/replace-member.sh" "$1" "$2" --lost-volume
bash "$(dirname "$0")/verify-mongo.sh" "$1"
bash "$(dirname "$0")/check-recovery.sh" after "$3"
k6 run -e VUS="${VUS:-50}" -e DURATION="${DURATION:-60s}" "$root/tests/load/client-api.k6.js"
