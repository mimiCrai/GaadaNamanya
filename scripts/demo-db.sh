#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

store=${1:-canonical-store}
if [[ $# -gt 0 ]]; then shift; fi
case "$store" in
    canonical-store|auth-store|dashboard-store|notification-store|bmkg-store|pvmbg-store) ;;
    *) echo "Store tidak dikenal: $store" >&2; exit 1 ;;
esac

# Allocate a TTY only for an interactive terminal.
tty_args=()
if [[ ! -t 0 || ! -t 1 ]]; then tty_args=(-T); fi
exec docker compose exec "${tty_args[@]}" "$store" sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"
