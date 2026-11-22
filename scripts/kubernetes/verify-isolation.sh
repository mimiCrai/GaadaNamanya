#!/usr/bin/env bash
set -euo pipefail
: "${KUBE_CONTEXT:?Set KUBE_CONTEXT explicitly}"
kubectl() { command kubectl --context "$KUBE_CONTEXT" "$@"; }
namespace=${1:-sistem-informasi-kebencanaan-bnpb}
# A DNS failure is an infrastructure failure, never proof of a NetworkPolicy denial.
probe='const net=require("node:net"),dns=require("node:dns");const [host,port,expect]=process.argv.slice(1);dns.lookup(host,(e,address)=>{if(e){console.error("DNS lookup failed");process.exit(2)}const s=net.connect({host:address,port:Number(port)});s.setTimeout(2500);s.on("connect",()=>{s.destroy();process.exit(expect==="allow"?0:1)});s.on("error",()=>process.exit(expect==="deny"?0:1));s.on("timeout",()=>{s.destroy();process.exit(expect==="deny"?0:1)});});'
check() {
  kubectl -n "$namespace" exec "deployment/$1" -- node -e "$probe" "$2" "$3" "$4"
  echo "$1 -> $2:$3: $4"
}
for pair in 'auth-store bnpb-auth bnpb-client-api' 'dashboard-store dashboard-consumer bnpb-auth' 'notification-store notification-consumer bnpb-auth' 'bmkg-store bmkg bnpb-auth' 'pvmbg-store pvmbg bnpb-auth' 'canonical-store bnpb-aggregator bnpb-auth'; do
  read -r store owner other <<< "$pair"
  port=5432
  [[ "$store" != canonical-store ]] || port=27017
  check "$owner" "$store" "$port" allow
  check "$other" "$store" "$port" deny
  for ip in $(kubectl -n "$namespace" get pods -l "app=$store" -o jsonpath='{.items[*].status.podIP}'); do
    check "$owner" "$ip" "$port" allow
    check "$other" "$ip" "$port" deny
  done
done
for store in canonical-config canonical-shard-a canonical-shard-b; do
  check bnpb-aggregator "$store" 27017 allow
  check bnpb-auth "$store" 27017 deny
  for ip in $(kubectl -n "$namespace" get pods -l "app=$store" -o jsonpath='{.items[*].status.podIP}'); do
    check bnpb-aggregator "$ip" 27017 allow
    check bnpb-auth "$ip" 27017 deny
  done
done
for owner in bnpb-client-api field-report-processor fire-processor; do
  check "$owner" kafka 29092 allow
done
check bnpb-auth kafka 29092 deny
for app in field-report-processor fire-processor; do
  check "$app" bnpb-aggregator 3000 allow
  check "$app" canonical-store 27017 deny
done
