#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
mode="${1:-smoke}"
target="${TARGET:-compose}"
case "$mode" in smoke|sustained|scaling|benchmark|rolling) ;; *) echo 'Usage: bash scripts/run-aggregator-load-test.sh [smoke|sustained|scaling|benchmark|rolling]' >&2; exit 1 ;; esac
case "$target" in compose|kubernetes) ;; *) echo 'TARGET must be compose or kubernetes' >&2; exit 1 ;; esac
for dependency in k6 curl; do command -v "$dependency" >/dev/null || { echo "Missing $dependency" >&2; exit 1; }; done

env_value() { sed -n "s/^$1=//p" .env 2>/dev/null | tr -d '\r' | tail -n 1; }
if [[ -z "${BNPB_INTERNAL_API_KEY:-}" ]]; then
    export BNPB_INTERNAL_API_KEY="$(env_value BNPB_AGGREGATOR_INTERNAL_API_KEY || true)"
fi
[[ -n "$BNPB_INTERNAL_API_KEY" ]] || { echo 'Set BNPB_INTERNAL_API_KEY or create root .env' >&2; exit 1; }
if [[ "$target" == kubernetes && -z "${AGGREGATOR_URL:-}" ]]; then echo 'Set AGGREGATOR_URL to the Kubernetes entry point' >&2; exit 1; fi
export AGGREGATOR_URL="${AGGREGATOR_URL:-http://localhost:$(env_value BNPB_AGGREGATOR_HOST_PORT || true)}"
[[ "$AGGREGATOR_URL" != 'http://localhost:' ]] || export AGGREGATOR_URL=http://localhost:3003
export VUS="${VUS:-10000}" DURATION_SECONDS="${DURATION_SECONDS:-150}" ITERATION_SLEEP_SECONDS="${ITERATION_SLEEP_SECONDS:-0}"
if [[ "$mode" == smoke ]]; then export VUS="${SMOKE_VUS:-5}" DURATION_SECONDS="${SMOKE_DURATION_SECONDS:-10}"; fi
[[ "$DURATION_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo 'DURATION_SECONDS must be a positive integer' >&2; exit 1; }
export LOAD_MODE="$mode" STRICT=false
[[ "$mode" != rolling ]] || export STRICT=true
RESULT_DIR="test-results/p2-load/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$RESULT_DIR"
printf 'utc_time,elapsed_seconds,event\n' > "$RESULT_DIR/events.csv"
printf 'Results: %s\nTarget: %s; mode: %s; VUs: %s; duration: %ss\n' "$RESULT_DIR" "$target" "$mode" "$VUS" "$DURATION_SECONDS"

controller=()
if [[ "$mode" == scaling || "$mode" == benchmark || "$mode" == rolling ]]; then
    if [[ "$target" == compose ]]; then
        [[ "$mode" != rolling ]] || { echo 'Rolling update verification requires TARGET=kubernetes' >&2; exit 1; }
        command -v docker >/dev/null || { echo 'Missing docker' >&2; exit 1; }
        controller=(docker compose)
    else
        command -v kubectl >/dev/null || { echo 'Missing kubectl' >&2; exit 1; }
        controller=(kubectl)
        [[ -z "${KUBE_CONTEXT:-}" ]] || controller+=(--context "$KUBE_CONTEXT")
        controller+=(--namespace "${KUBE_NAMESPACE:-sistem-informasi-kebencanaan-bnpb}")
    fi
fi
deployment="${AGGREGATOR_DEPLOYMENT:-bnpb-aggregator}"
container="${AGGREGATOR_CONTAINER:-bnpb-aggregator}"
original_replicas=''
original_image=''
load_pid=''
start_seconds=$SECONDS

event() { printf '%s,%s,%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$((SECONDS - start_seconds))" "$1" | tee -a "$RESULT_DIR/events.csv"; }
ready() {
    local deadline=$((SECONDS + 180))
    while ! curl --silent --fail --max-time 5 "${AGGREGATOR_URL%/}/health/ready" >/dev/null; do
        (( SECONDS < deadline )) || { echo 'Aggregator entry did not become ready' >&2; return 1; }
        sleep 2
    done
}
scale() {
    event "scale_requested_$1"
    if [[ "$target" == kubernetes ]]; then
        "${controller[@]}" scale "deployment/$deployment" --replicas="$1" || return 1
        "${controller[@]}" rollout status "deployment/$deployment" --timeout=180s || return 1
    else
        "${controller[@]}" up -d --no-deps --scale "bnpb-aggregator=$1" bnpb-aggregator || return 1
        local ids
        ids="$("${controller[@]}" ps -q --status running bnpb-aggregator)" || return 1
        [[ "$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l | tr -d ' ')" == "$1" ]] || { echo 'Replica count does not match requested scale' >&2; return 1; }
        for id in $ids; do
            docker exec "$id" node -e 'const end=Date.now()+180000; async function wait(){try{const r=await fetch(`http://localhost:${process.env.PORT}/health/ready`,{signal:AbortSignal.timeout(5000)});if(r.ok)return;}catch{}if(Date.now()>end)process.exit(1);setTimeout(wait,1000);}wait();' || return 1
        done
        sleep 5
    fi
    ready || return 1
    event "scale_ready_$1"
}
cleanup() {
    local status=$?
    trap - EXIT INT TERM
    if [[ -n "$load_pid" ]]; then kill "$load_pid" 2>/dev/null || true; wait "$load_pid" 2>/dev/null || true; fi
    if [[ -n "$original_image" ]]; then
        "${controller[@]}" set image "deployment/$deployment" "$container=$original_image" || status=1
        "${controller[@]}" rollout status "deployment/$deployment" --timeout=180s || status=1
    fi
    if [[ -n "$original_replicas" ]]; then scale "$original_replicas" || status=1; fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if (( ${#controller[@]} )); then
    if [[ "$target" == kubernetes ]]; then
        original_replicas="$("${controller[@]}" get "deployment/$deployment" -o jsonpath='{.spec.replicas}')"
    else
        original_replicas="$("${controller[@]}" ps -q --status running bnpb-aggregator | wc -l | tr -d ' ')"
    fi
    [[ "$original_replicas" =~ ^[1-9][0-9]*$ ]] || { original_replicas=''; echo 'Start the deployment before running this script' >&2; exit 1; }
fi
if [[ "$mode" == rolling ]]; then
    [[ -n "${AGGREGATOR_IMAGE:-}" ]] || { echo 'Set AGGREGATOR_IMAGE to a new immutable image tag/digest' >&2; exit 1; }
    original_image="$("${controller[@]}" get "deployment/$deployment" -o "jsonpath={.spec.template.spec.containers[?(@.name=='$container')].image}")"
    [[ -n "$original_image" && "$original_image" != "$AGGREGATOR_IMAGE" ]] || { original_image=''; echo 'Need an existing container and a different image' >&2; exit 1; }
fi

run_load() {
    local label="$1"
    export SUMMARY_PATH="$RESULT_DIR/$label.json"
    k6 run --quiet tests/load/aggregator-p2.k6.js > "$RESULT_DIR/$label.log" 2>&1 &
    load_pid=$!
    local deadline=$((SECONDS + 180))
    until grep -q 'P2_LOAD_STARTED' "$RESULT_DIR/$label.log"; do
        if ! kill -0 "$load_pid" 2>/dev/null || (( SECONDS >= deadline )); then
            cat "$RESULT_DIR/$label.log" >&2
            echo 'k6 did not start its workload' >&2
            return 1
        fi
        sleep 1
    done
    start_seconds=$SECONDS
    event "load_started_$label"
}
finish_load() {
    local status=0
    wait "$load_pid" || status=$?
    load_pid=''
    cat "$RESULT_DIR/$1.log"
    event "load_finished_$1"
    return "$status"
}
wait_until() {
    local at="$1"
    while (( SECONDS - start_seconds < at )); do
        kill -0 "$load_pid" 2>/dev/null || { echo 'k6 exited before the scheduled action' >&2; return 1; }
        sleep 1
    done
    kill -0 "$load_pid" 2>/dev/null || { echo 'k6 is no longer running' >&2; return 1; }
}
native_path() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

ready
case "$mode" in
    smoke|sustained)
        run_load "$mode"
        finish_load "$mode"
        ;;
    scaling)
        (( DURATION_SECONDS >= 15 )) || { echo 'Scaling needs at least 15 seconds' >&2; exit 1; }
        scale 3
        run_load scaling
        wait_until "$((DURATION_SECONDS / 3))"
        scale 5
        wait_until "$((DURATION_SECONDS * 2 / 3))"
        scale 2
        kill -0 "$load_pid" 2>/dev/null || { echo 'Scaling completed after the load ended; increase DURATION_SECONDS' >&2; exit 1; }
        finish_load scaling
        ;;
    benchmark)
        scale 1
        run_load baseline
        finish_load baseline
        scale 3
        run_load scaled
        finish_load scaled
        export BASELINE_SUMMARY="$(native_path "$ROOT_DIR/$RESULT_DIR/baseline.json")"
        export SCALED_SUMMARY="$(native_path "$ROOT_DIR/$RESULT_DIR/scaled.json")"
        export COMPARISON_PATH="$RESULT_DIR/comparison.json"
        k6 run --quiet tests/load/compare-aggregator-p2.k6.js
        ;;
    rolling)
        scale 3
        run_load rolling
        wait_until "$((DURATION_SECONDS / 3))"
        event rolling_update_requested
        "${controller[@]}" set image "deployment/$deployment" "$container=$AGGREGATOR_IMAGE"
        "${controller[@]}" rollout status "deployment/$deployment" --timeout="${DURATION_SECONDS}s"
        kill -0 "$load_pid" 2>/dev/null || { echo 'Rolling update completed after load ended; increase DURATION_SECONDS' >&2; exit 1; }
        event rolling_update_ready
        finish_load rolling
        ;;
esac
