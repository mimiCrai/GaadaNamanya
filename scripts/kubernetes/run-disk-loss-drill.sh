#!/usr/bin/env bash
set -euo pipefail
: "${KUBE_CONTEXT:?Set KUBE_CONTEXT explicitly}"
kubectl() { command kubectl --context "$KUBE_CONTEXT" "$@"; }

if [[ $# -lt 4 ]]; then
  echo 'Usage: run-disk-loss-drill.sh NAMESPACE REPLICA_SET ORDINAL BASELINE_JSON [--replacement-node NODE] [--node-fenced]' >&2
  exit 2
fi
root=$(cd "$(dirname "$0")/../.." && pwd)
namespace=$1
replica_set=$2
ordinal=$3
baseline=$4
shift 4
bash "$(dirname "$0")/check-recovery.sh" before "$baseline"
bash "$(dirname "$0")/replace-member.sh" "$namespace" "$replica_set" "$ordinal" --lost-volume "$@"
bash "$(dirname "$0")/verify-mongo.sh" "$namespace"
bash "$(dirname "$0")/check-recovery.sh" after "$baseline"
k6 run -e VUS="${VUS:-50}" -e DURATION="${DURATION:-60s}" "$root/tests/load/client-api.k6.js"
