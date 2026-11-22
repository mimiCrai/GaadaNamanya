# Source from the repository root in Git Bash before collecting report evidence.
export KUBE_CONTEXT="${KUBE_CONTEXT:-k3d-bnpb-local}"
export KUBE_NAMESPACE="${KUBE_NAMESPACE:-sistem-informasi-kebencanaan-bnpb}"
export TARGET=kubernetes
if [[ -x ./test-results/local-k3d/kubectl.exe ]]; then
    export PATH="$PWD/test-results/local-k3d:$PATH"
    export KUBECONFIG="${KUBECONFIG:-$(cygpath -aw test-results/local-k3d/kubeconfig.yaml)}"
fi
export AGGREGATOR_URL="${AGGREGATOR_URL:-http://127.0.0.1:3003}"
export CLIENT_API_BASE_URL="${CLIENT_API_BASE_URL:-http://127.0.0.1:3000}"
export AUTH_BASE_URL="${AUTH_BASE_URL:-http://127.0.0.1:3001}"
export BMKG_URL="${BMKG_URL:-http://127.0.0.1:8081}"
export PVMBG_URL="${PVMBG_URL:-http://127.0.0.1:8082}"
export SENSOR_URL="${SENSOR_URL:-http://127.0.0.1:8083}"
export NOTIFICATION_URL="${NOTIFICATION_URL:-http://127.0.0.1:3005}"
mkdir -p test-results/report

kn() { MSYS_NO_PATHCONV=1 command kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" "$@"; }
utc() { date -u '+%Y-%m-%dT%H:%M:%S.%3NZ'; }

evidence() {
    local action=${1:-} pod_info node_id container_id credentials password media field helper requested_at attempt
    case "$action" in
        start)
            k3d.exe cluster start bnpb-local && docker start bnpb-local-access && evidence forward
            ;;
        forward|seed)
            helper=$(cygpath -aw test-results/local-k3d/finish-local.ps1) || return
            if [[ "$action" == seed ]]; then
                powershell.exe -NoProfile -File "$helper"
            elif [[ -n ${2:-} ]]; then
                powershell.exe -NoProfile -File "$helper" -ForwardOnly -Services "$2"
            else
                powershell.exe -NoProfile -File "$helper" -ForwardOnly
            fi
            ;;
        keys)
            # Git Bash aliases interactive node to winpty; pipes need the executable directly.
            credentials=$(set -o pipefail; kn get secret bnpb-aggregator-secret -o json --request-timeout=8s | command node -e '
                const secret = JSON.parse(require("node:fs").readFileSync(0, "utf8")).data;
                const keys = ["BNPB_INTERNAL_API_KEY", "BNPB_AUDIT_TOKEN", "BMKG_API_KEY", "PVMBG_TOKEN", "SENSOR_PANTAI_TOKEN"];
                if (keys.some(key => !secret[key])) throw new Error("Aggregator Secret is missing a required key");
                for (const key of keys) console.log(Buffer.from(secret[key], "base64").toString());
            ') || return
            local -a values
            mapfile -t values <<< "$credentials"
            export BNPB_INTERNAL_API_KEY="${values[0]}" BNPB_AUDIT_TOKEN="${values[1]}"
            export BMKG_API_KEY="${values[2]}" PVMBG_TOKEN="${values[3]}" SENSOR_TOKEN="${values[4]}"
            ;;
        copy)
            case "${2:-}" in
                internal) printf '%s' "${BNPB_INTERNAL_API_KEY:?Run evidence keys first}" | clip.exe ;;
                audit) printf '%s' "${BNPB_AUDIT_TOKEN:?Run evidence keys first}" | clip.exe ;;
                *) echo 'Usage: evidence copy internal|audit' >&2; return 2 ;;
            esac
            ;;
        crash)
            unset P2_FAULT_AT P2_TAKEOVER_AT P2_WINDOW_END
            if [[ "$KUBE_CONTEXT" != k3d-bnpb-local || -z ${2:-} ]]; then
                echo 'Usage on local k3d: evidence crash POD_NAME' >&2; return 2
            fi
            pod_info=$(set -o pipefail; kn get pod "$2" -o json --request-timeout=5s | command node -e '
                const pod = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
                const id = pod.status.containerStatuses?.find(c => c.name === "bnpb-aggregator" && c.state?.running)?.containerID;
                if (pod.metadata.labels.app !== "bnpb-aggregator" || !id?.match(/^containerd:\/\/[a-f0-9]+$/)) {
                    throw new Error("An active Aggregator container is required");
                }
                console.log(pod.spec.nodeName, id.split("//")[1]);
            ') || return
            read -r node_id container_id <<< "$pod_info"
            requested_at=$(utc)
            if docker exec "$node_id" crictl stop --timeout 0 "$container_id"; then
                P2_FAULT_AT=$requested_at
            else
                for attempt in 1 2 3; do
                    if (set -o pipefail; kn get pod "$2" -o json --request-timeout=5s | command node -e '
                        const pod = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
                        const status = pod.status.containerStatuses?.find(c => c.name === "bnpb-aggregator");
                        const id = `containerd://${process.argv[1]}`;
                        const terminated = [status?.state?.terminated, status?.lastState?.terminated];
                        process.exitCode = terminated.some(c => c?.containerID === id) ? 0 : 1;
                    ' "$container_id"); then
                        printf 'Kubernetes confirmed the targeted container stopped.\n'
                        P2_FAULT_AT=$requested_at
                        break
                    fi
                    sleep 1
                done
                if [[ -z ${P2_FAULT_AT:-} ]]; then
                    echo 'Crash could not be verified. Takeover evidence was not recorded.' >&2
                    return 1
                fi
            fi
            printf 'Fault requested at %s\n' "$P2_FAULT_AT"
            ;;
        takeover)
            if [[ -z ${P2_FAULT_AT:-} ]]; then
                echo 'Run evidence crash successfully or record the team crash time first.' >&2
                return 2
            fi
            P2_TAKEOVER_AT=$(utc)
            printf 'Takeover observed at %s\n' "$P2_TAKEOVER_AT"
            ;;
        reconcile)
            if [[ -z ${P2_FAULT_AT:-} || -z ${P2_TAKEOVER_AT:-} ]]; then
                echo 'Record a confirmed crash and observed takeover first.' >&2
                return 2
            fi
            P2_WINDOW_END=${P2_WINDOW_END:-$(utc)}
            (set -o pipefail; command node scripts/kubernetes/reconcile-poll-window.mjs \
                --since "$P2_FAULT_AT" --until "$P2_WINDOW_END" \
                --fault-at "$P2_FAULT_AT" --takeover-at "$P2_TAKEOVER_AT" \
                | tee test-results/report/p2-crash.json)
            ;;
        check-polls)
            (set -o pipefail; command node scripts/kubernetes/reconcile-poll-window.mjs \
                --since "${2:?Pass the start time from utc}" --until "${3:-$(utc)}" \
                | tee test-results/report/p2-normal.json)
            ;;
        measure)
            command node scripts/sensor-pantai/measure-e2e.mjs --duration-seconds "${3:-300}" --drain-seconds 15 \
                --output "test-results/report/${2:-p5-measurement}.json"
            ;;
        latency)
            case "${2:-}" in baseline|fault) ;; *) echo 'Usage: evidence latency baseline|fault' >&2; return 2 ;; esac
            read -rsp 'Password Media: ' password; echo
            MEDIA_PASSWORD="$password" k6 run --summary-export "test-results/report/p5-isolation-$2.json" \
                tests/load/sensor-isolation-p5.k6.js
            ;;
        priority)
            read -rsp 'Access token Media: ' media; echo
            read -rsp 'Access token Lapangan: ' field; echo
            MEDIA_TOKEN="$media" FIELD_TOKEN="$field" MEDIA_VUS="${2:-20}" FIELD_VUS="${3:-5}" \
                k6 run --summary-export test-results/report/p5-priority.json tests/load/priority-p5.k6.js
            ;;
        *) echo 'Commands: start, forward, seed, keys, copy, check-polls, crash, takeover, reconcile, measure, latency, priority' >&2; return 2 ;;
    esac
}
