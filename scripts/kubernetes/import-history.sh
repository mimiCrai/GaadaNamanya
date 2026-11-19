#!/usr/bin/env bash
set -Eeuo pipefail
# Stop background work while retaining a separate importer Pod. Normal serving resumes afterward.
if [[ $# -ne 1 || ! -f $1 ]]; then echo 'Usage: KUBE_CONTEXT=... bash scripts/kubernetes/import-history.sh CATALOG.ndjson' >&2; exit 2; fi
: "${KUBE_CONTEXT:?Set the target context explicitly}"
namespace=sistem-informasi-kebencanaan-bnpb
k=(kubectl --context "$KUBE_CONTEXT" -n "$namespace")
replicas=$("${k[@]}" get deployment/bnpb-aggregator -o jsonpath='{.spec.replicas}')
job="history-import-$(date +%s)"
restore() {
  local status=$?
  trap - EXIT
  "${k[@]}" scale deployment/bnpb-aggregator --replicas="$replicas" || status=1
  "${k[@]}" rollout status deployment/bnpb-aggregator --timeout=5m || status=1
  "${k[@]}" delete pod "$job" --ignore-not-found --wait=false || status=1
  exit "$status"
}
trap restore EXIT
# Copy the Deployment's exact env, identity and imagePullSecrets, but run only the importer.
"${k[@]}" get deployment/bnpb-aggregator -o json | python3 -c '
import json,sys
x=json.load(sys.stdin)["spec"]["template"]
x["apiVersion"]="v1"; x["kind"]="Pod"; x["metadata"]["name"]=sys.argv[1]
x["metadata"]["labels"]={"app":"bnpb-aggregator","role":"aggregator","part-of":"bnpb"}
s=x["spec"];s["restartPolicy"]="Never";s.pop("topologySpreadConstraints",None)
c=s["containers"][0]
for key in ("readinessProbe","startupProbe","livenessProbe","lifecycle"): c.pop(key,None)
c["readinessProbe"]={"exec":{"command":["sh","-c","exit 1"]},"periodSeconds":3}
c["command"]=["sh","-c","while [ ! -f /tmp/catalog.ready ]; do sleep 1; done; exec npm run data:import -- /tmp/catalog.ndjson"]
print(json.dumps(x))' "$job" | "${k[@]}" create -f -
"${k[@]}" wait --for=jsonpath='{.status.phase}'=Running "pod/$job" --timeout=5m
"${k[@]}" cp "$1" "$job:/tmp/catalog.ndjson"
"${k[@]}" scale deployment/bnpb-aggregator --replicas=0
"${k[@]}" wait --for=delete pod -l 'app=bnpb-aggregator,!statefulset.kubernetes.io/pod-name' --field-selector="metadata.name!=$job" --timeout=2m
"${k[@]}" exec "$job" -- touch /tmp/catalog.ready
for attempt in $(seq 1 900); do
  phase=$("${k[@]}" get pod "$job" -o jsonpath='{.status.phase}')
  if [[ "$phase" == Succeeded ]]; then "${k[@]}" logs "$job"; exit 0; fi
  if [[ "$phase" == Failed ]]; then "${k[@]}" logs "$job" >&2; exit 1; fi
  sleep 1
done
echo 'Import timeout (15 minutes); inspect importer logs' >&2
exit 1
