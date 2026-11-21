#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || ( $1 != before && $1 != after ) ]]; then
  echo 'Usage: check-recovery.sh before|after BASELINE_JSON' >&2
  exit 2
fi
: "${BNPB_AGGREGATOR_AUDIT_TOKEN:?Set audit token}"
url=${AGGREGATOR_URL:-http://localhost:3003}
response=$(curl -fsS --connect-timeout 3 --max-time 10 -H "Authorization: Bearer $BNPB_AGGREGATOR_AUDIT_TOKEN" "$url/internal/audit/checksum")
if [[ $1 == before ]]; then
  python3 -c 'import json,sys; x=json.load(sys.stdin); assert not x["partial"], "partial audit read"; print(json.dumps({"count":x["count"],"checksum":x["checksum"]}))' <<<"$response" > "$2"
  cat "$2"
else
  python3 -c 'import json,sys; a=json.load(open(sys.argv[1])); b=json.load(sys.stdin); assert not b["partial"], "partial audit read"; assert a=={"count":b["count"],"checksum":b["checksum"]}, "checksum/count mismatch"; print("Checksum and count match baseline:",a)' "$2" <<<"$response"
fi
