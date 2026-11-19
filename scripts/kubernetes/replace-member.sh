#!/usr/bin/env bash
set -euo pipefail
: "${KUBE_CONTEXT:?Set KUBE_CONTEXT explicitly}"
kubectl() { command kubectl --context "$KUBE_CONTEXT" "$@"; }

if [[ $# -ne 3 || $3 != --lost-volume ]]; then
  echo 'Usage: replace-member.sh NAMESPACE canonical-config|canonical-shard-a|canonical-shard-b --lost-volume' >&2
  exit 2
fi
namespace=$1
set=$2
[[ $set =~ ^canonical-(config|shard-a|shard-b)$ ]] || exit 2
target="$set-2"

# A replica set must retain two healthy copies before a lost PVC is discarded.
survivor=''
for n in 0 1 2; do
  if [[ $n != 2 ]] && kubectl -n "$namespace" exec "$set-$n" -- mongosh --quiet --eval '
    const a = db.getSiblingDB("admin");
    a.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);
    const target = "'"$target"'";
    const healthy = a.runCommand({ replSetGetStatus: 1 }).members.filter(m =>
      !m.name.startsWith(target + ".") && m.health === 1 && [1, 2].includes(m.state));
    quit(healthy.length >= 2 ? 0 : 1);
  ' >/dev/null 2>&1; then
    survivor="$set-$n"
    break
  fi
done
if [[ -z $survivor ]]; then
  echo 'Refusing replacement: fewer than two healthy replica set members' >&2
  exit 1
fi

kubectl -n "$namespace" scale "statefulset/$set" --replicas=2
kubectl -n "$namespace" rollout status "statefulset/$set" --timeout=5m
kubectl -n "$namespace" wait --for=delete "pod/$target" --timeout=5m
kubectl -n "$namespace" delete pvc "data-$target" --wait=true --timeout=5m
kubectl -n "$namespace" scale "statefulset/$set" --replicas=3
kubectl -n "$namespace" rollout status "statefulset/$set" --timeout=15m
for attempt in $(seq 1 120); do
  if kubectl -n "$namespace" exec "$survivor" -- mongosh --quiet --eval "
    const a = db.getSiblingDB('admin');
    a.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);
    const m = a.runCommand({ replSetGetStatus: 1 }).members.find(m => m.name.startsWith('$target.'));
    quit(m && m.health === 1 && [1, 2].includes(m.state) ? 0 : 1);
  " >/dev/null 2>&1; then
    echo "$target recovered as a healthy data member"
    exit 0
  fi
  sleep 5
done
echo "$target did not become a healthy data member" >&2
exit 1
