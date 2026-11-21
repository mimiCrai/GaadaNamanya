#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
[[ -f .env ]] || { echo 'Create .env first: cp .env.example .env' >&2; exit 1; }

compose=(docker compose -f docker-compose.yml -f docker-compose.observability.yml)
"${compose[@]}" up --build -d
echo "Grafana: http://$("${compose[@]}" port grafana 3000) (credentials: .env)"
