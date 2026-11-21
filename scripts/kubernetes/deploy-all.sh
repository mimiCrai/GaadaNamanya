#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root=$(cd "$(dirname "$0")/../.." && pwd)
config=${BNPB_DEPLOY_CONFIG:-$root/k8s/full-stack.json}
secrets=${BNPB_DEPLOY_SECRETS:-$root/.env.k8s}
for program in kubectl docker python3; do
  command -v "$program" >/dev/null || { echo "Missing command: $program" >&2; exit 1; }
done
test -f "$config" || { echo 'Copy k8s/full-stack.json.example to k8s/full-stack.json; see petunjuk.md.' >&2; exit 1; }
test -f "$secrets" || { echo 'Run python3 scripts/kubernetes/init-secrets.py first.' >&2; exit 1; }
context=${KUBE_CONTEXT:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("context", ""))' "$config")}
: "${context:?Set context in deployment config or KUBE_CONTEXT}"
export KUBE_CONTEXT="$context"
namespace=sistem-informasi-kebencanaan-bnpb
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
# Every child process uses the explicit context, without changing the user's current context.
kubectl --context "$context" config view --minify --flatten --raw > "$tmp_dir/kubeconfig"
export KUBECONFIG="$tmp_dir/kubeconfig"
trap 'status=$?; echo "Deployment failed (exit $status). Inspect: kubectl --context $context -n $namespace get pods,jobs,events; kubectl --context $context -n $namespace logs job/JOB_NAME" >&2; exit "$status"' ERR
python3 "$root/scripts/kubernetes/check-demo-cluster.py" "$config"
python3 "$root/scripts/kubernetes/render-full-stack.py" "$config" "$secrets" "$tmp_dir"
# Never silently replace passwords on persistent, already-initialized databases.
if [[ -n $(kubectl get namespace "$namespace" -o name --ignore-not-found) ]]; then
  kubectl -n "$namespace" get secrets -o json > "$tmp_dir/existing-secrets.json"
else
  printf '{"items":[]}\n' > "$tmp_dir/existing-secrets.json"
fi
python3 - "$tmp_dir" <<'PY'
import base64,json,sys
from pathlib import Path
p=Path(sys.argv[1])
existing={x['metadata']['name']:x for x in json.loads((p/'existing-secrets.json').read_text())['items']}
for obj in json.loads((p/'config.json').read_text())['items']:
    old=existing.get(obj['metadata']['name'])
    if obj['kind']=='Secret' and old:
        for key,value in obj['stringData'].items():
            previous=old.get('data',{}).get(key)
            if previous is not None and base64.b64decode(previous).decode()!=value:
                raise SystemExit('Credential mismatch for Secret '+obj['metadata']['name']+' / '+key+'. Restore the original credential file; rotation requires a database-aware procedure.')
PY
repository=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["imageRepository"])' "$config")
tag=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["imageTag"])' "$config")
pull_secret=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("imagePullSecret", ""))' "$config")
if [[ -n "$pull_secret" ]]; then kubectl -n "$namespace" get secret "$pull_secret" >/dev/null; fi
if [[ ${SKIP_IMAGE_BUILD:-0} != 1 ]]; then
  for app in bnpb-auth bnpb-client-api bnpb-aggregator dashboard-consumer notification-consumer bmkg pvmbg field-report-processor fire-processor; do
    docker build -t "$repository:$app-$tag" "$root/services/$app"
    docker push "$repository:$app-$tag"
  done
fi
kubectl create namespace "$namespace" --dry-run=client -o json | kubectl apply -f -
kubectl -n "$namespace" create configmap canonical-mongo-scripts \
  --from-file="$root/scripts/mongodb/start.sh" \
  --from-file="$root/scripts/mongodb/init-replica-sets.js" \
  --from-file="$root/scripts/mongodb/init-sharding.js" \
  --dry-run=client -o json | kubectl -n "$namespace" apply -f -
for file in config policies mongo; do kubectl -n "$namespace" apply -f "$tmp_dir/$file.json"; done
for set in canonical-config canonical-shard-a canonical-shard-b; do
  kubectl -n "$namespace" rollout status "statefulset/$set" --timeout=15m
done
run_job() {
  local file=$1 job
  job=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["items"][0]["metadata"]["name"])' "$tmp_dir/$file.json")
  kubectl -n "$namespace" apply -f "$tmp_dir/$file.json"
  kubectl -n "$namespace" wait --for=condition=complete "job/$job" --timeout=15m
}
run_job replica-init-job
kubectl -n "$namespace" rollout status deployment/canonical-store --timeout=10m
run_job sharding-init-job
run_job migrate-job
kubectl -n "$namespace" apply -f "$tmp_dir/infra.json"
for set in auth-store dashboard-store notification-store bmkg-store pvmbg-store kafka sensor-pantai; do
  kubectl -n "$namespace" rollout status "statefulset/$set" --timeout=15m
done
run_job kafka-job
kubectl -n "$namespace" apply -f "$tmp_dir/applications.json"
for app in bnpb-auth bnpb-client-api bnpb-aggregator dashboard-consumer notification-consumer bmkg pvmbg field-report-processor fire-processor; do
  kubectl -n "$namespace" rollout status "deployment/$app" --timeout=15m
done
bash "$root/scripts/kubernetes/verify-mongo.sh" "$namespace"
bash "$root/scripts/kubernetes/verify-isolation.sh" "$namespace"
python3 "$root/scripts/kubernetes/verify-platform.py" "$namespace"
# Smoke the real service path, using the owning application's secret inside the Pod.
kubectl -n "$namespace" exec deployment/bnpb-aggregator -- node -e '
(async()=>{for(const [url,headers] of [
 ["http://bnpb-aggregator:3000/health/ready",{}],
 ["http://bnpb-aggregator:3000/internal/audit/events?limit=1",{Authorization:`Bearer ${process.env.BNPB_AUDIT_TOKEN}`}]
]) { const r=await fetch(url,{headers,signal:AbortSignal.timeout(8000)}); if(!r.ok)throw Error(`${url}: ${r.status}`); }})().catch(e=>{console.error(e.message);process.exit(1)});'
kubectl -n "$namespace" exec deployment/dashboard-consumer -- node -e '
fetch("http://localhost:3000/api/hazards/analytics",{signal:AbortSignal.timeout(10000)}).then(async r=>{const b=await r.json();if(!r.ok || b.partial)process.exit(1)}).catch(()=>process.exit(1));'
kubectl -n "$namespace" get pods,sts,deploy,jobs,pvc
echo "Deployment and smoke checks completed in context $context, namespace $namespace"
