#!/usr/bin/env bash
set -euo pipefail
: "${KUBE_CONTEXT:?Set KUBE_CONTEXT explicitly}"
kubectl() { command kubectl --context "$KUBE_CONTEXT" "$@"; }

namespace=${1:-sistem-informasi-kebencanaan-bnpb}
: "${MONGO_INITDB_ROOT_USERNAME:?Set MongoDB root user}"
: "${MONGO_INITDB_ROOT_PASSWORD:?Set MongoDB root password}"
: "${MONGO_CLUSTER_KEY:?Set a shared MongoDB cluster key}"
: "${CANONICAL_STORE_DB_USER:?Set application database user}"
: "${CANONICAL_STORE_DB_PASSWORD:?Set application database password}"
: "${DATABASE_URL:?Set root MongoDB URI for migration job}"

root=$(cd "$(dirname "$0")/../.." && pwd)
kubectl -n "$namespace" create secret generic canonical-mongo \
  --from-literal=MONGO_INITDB_ROOT_USERNAME="$MONGO_INITDB_ROOT_USERNAME" \
  --from-literal=MONGO_INITDB_ROOT_PASSWORD="$MONGO_INITDB_ROOT_PASSWORD" \
  --from-literal=MONGO_CLUSTER_KEY="$MONGO_CLUSTER_KEY" \
  --from-literal=MONGO_TRANSACTION_LIFETIME_SECONDS="${CANONICAL_STORE_TRANSACTION_LIFETIME_SECONDS:-10}" \
  --from-literal=CANONICAL_STORE_DB_NAME=canonical_store \
  --from-literal=CANONICAL_STORE_DB_USER="$CANONICAL_STORE_DB_USER" \
  --from-literal=CANONICAL_STORE_DB_PASSWORD="$CANONICAL_STORE_DB_PASSWORD" \
  --from-literal=DATABASE_URL="$DATABASE_URL" \
  --dry-run=client -o yaml | kubectl -n "$namespace" apply -f -
kubectl -n "$namespace" create configmap canonical-mongo-scripts \
  --from-file="$root/scripts/mongodb/start.sh" \
  --from-file="$root/scripts/mongodb/init-replica-sets.js" \
  --from-file="$root/scripts/mongodb/init-sharding.js" \
  --dry-run=client -o yaml | kubectl -n "$namespace" apply -f -
kubectl -n "$namespace" apply -f "$root/k8s/mongo.yaml"
for set in canonical-config canonical-shard-a canonical-shard-b; do
  kubectl -n "$namespace" rollout status "statefulset/$set" --timeout=10m
done
for job in replica-init sharding-init migrate; do
  kubectl -n "$namespace" apply -f "$root/k8s/$job.yaml"
  kubectl -n "$namespace" wait --for=condition=complete "job/canonical-$job" --timeout=10m
done
kubectl -n "$namespace" rollout status deployment/canonical-store --timeout=5m
