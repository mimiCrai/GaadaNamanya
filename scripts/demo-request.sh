#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: bash scripts/demo-request.sh URL [curl options...]" >&2
    exit 1
fi

url=$1
shift
curl --silent --show-error --max-time "${REQUEST_TIMEOUT_SECONDS:-30}" \
    --write-out '\nHTTP %{http_code} | Latensi total %{time_total} detik\n' \
    "$@" "$url"
