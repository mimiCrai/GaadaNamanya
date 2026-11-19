#!/usr/bin/env bash
set -euo pipefail
: "${KUBE_CONTEXT:?Set KUBE_CONTEXT explicitly}"
kubectl() { command kubectl --context "$KUBE_CONTEXT" "$@"; }

if [[ $# -ne 3 || $3 != --drain ]]; then
  echo 'Usage: replace-node.sh NAMESPACE NODE --drain' >&2
  exit 2
fi
namespace=$1
node=$2
[[ $node =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || exit 2

# PDBs require two available members per replica set during eviction.
kubectl cordon "$node"
kubectl drain "$node" --pod-selector='app in (canonical-config,canonical-shard-a,canonical-shard-b,canonical-store)' \
  --ignore-daemonsets --delete-emptydir-data --timeout=20m
for set in canonical-config canonical-shard-a canonical-shard-b; do
  kubectl -n "$namespace" rollout status "statefulset/$set" --timeout=20m
done
kubectl -n "$namespace" rollout status deployment/canonical-store --timeout=10m
bash "$(dirname "$0")/verify-mongo.sh" "$namespace"
