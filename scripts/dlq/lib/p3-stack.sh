# Shared helpers for the P3 scripts (scripts/dlq, scripts/field-reports); source after setting COMPOSE_PROJECT_NAME.
# Pattern from scripts/satellite/p4-reconnect-test.sh: isolated project, --env-file .env.example, docker exec helpers.

export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
ENV_FILE=${P3_ENV_FILE:-.env.example}
# sensor pantai is not part of P3; keep its poller quiet so logs and memory stay focused
export BNPB_AGGREGATOR_SENSOR_PANTAI_ENABLED=${BNPB_AGGREGATOR_SENSOR_PANTAI_ENABLED:-false}
compose=(docker compose -p "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.e2e.yml)

# per-run override with the production values from .env.example (the e2e file fixes both for its own tests):
#   PVMBG_REQUEST_TIMEOUT_MS=1000 also bounds the body read, so a 12 MiB oversized body ends as a timeout, not payload_too_large;
#   POLL_OVERLAP_MS=0 loses a record whose reported_at (source clock) is just below the checkpoint (store clock), see PLAN T4
p3_override() {
    local file="$1/p3-override.yml"
    printf 'services:\n    bnpb-aggregator:\n        environment:\n            PVMBG_REQUEST_TIMEOUT_MS: %s\n            POLL_OVERLAP_MS: %s\n' \
        "$(envval BNPB_AGGREGATOR_PVMBG_REQUEST_TIMEOUT_MS)" "$(envval BNPB_AGGREGATOR_POLL_OVERLAP_MS)" > "$file"
    compose+=(-f "$file")
}

envval() { grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r'; }
bold() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
# print a command before running it (demo readability)
show() { printf '   \033[2m$ %s\033[0m\n' "$*"; }

containers() {
    docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
        --filter "label=com.docker.compose.service=$1" --filter status=running
}
first() { containers "$1" | head -1; }
cname() { docker inspect -f '{{.Name}}' "$1" | sed 's#^/##'; }
restarts() { docker inspect -f '{{.RestartCount}}' "$1"; }

# HTTP inside an Aggregator container: agg <container> <METHOD> <path> [internal|audit] [json-body]
agg() {
    docker exec "$1" node -e '
        const [method, path, auth, body] = process.argv.slice(1);
        const headers = auth === "audit"
            ? { Authorization: `Bearer ${process.env.BNPB_AUDIT_TOKEN}` }
            : { "X-BNPB-Internal-Key": process.env.BNPB_INTERNAL_API_KEY };
        if (body) headers["content-type"] = "application/json";
        fetch("http://localhost:3000" + path, { method, headers, body: body || undefined })
            .then(async (r) => process.stdout.write(await r.text()))
            .catch(() => process.stdout.write("{}"));' "$2" "$3" "${4:-internal}" "${5:-}" 2>/dev/null || echo '{}'
}
# any Aggregator replica (they share the store)
agg1() { agg "$(first bnpb-aggregator)" "$@"; }

# HTTP inside the PVMBG mock with its own client token: mock <METHOD> <path> [json-body]
mock() {
    docker exec "$(first pvmbg)" node -e '
        const [method, path, body] = process.argv.slice(1);
        const token = (process.env.PVMBG_CLIENT_TOKENS || "").split(",")[0].trim();
        const headers = { Authorization: `Bearer ${token}` };
        if (body) headers["content-type"] = "application/json";
        fetch("http://localhost:8082" + path, { method, headers, body: body || undefined })
            .then(async (r) => process.stdout.write(await r.text()))
            .catch((e) => process.stdout.write(JSON.stringify({ error: String(e) })));' "$1" "$2" "${3:-}"
}

# several POSTs to the mock in one process, back to back (no poll can slip in between): mock_post_all <path> <body>...
mock_post_all() {
    docker exec "$(first pvmbg)" node -e '
        const [path, ...bodies] = process.argv.slice(1);
        const token = (process.env.PVMBG_CLIENT_TOKENS || "").split(",")[0].trim();
        (async () => { let last = "";
            for (const body of bodies) {
                const r = await fetch("http://localhost:8082" + path, { method: "POST", body,
                    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" } });
                last = await r.text();
            }
            process.stdout.write(last); })();' "$@"
}

# Client API from inside its container with a bearer token: api <METHOD> <path> <token> [json-body]; prints "<status> <body>"
api() {
    docker exec "$(first bnpb-client-api)" node -e '
        const [method, path, token, body] = process.argv.slice(1);
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        if (body) headers["content-type"] = "application/json";
        fetch("http://localhost:3000" + path, { method, headers, body: body || undefined })
            .then(async (r) => process.stdout.write(`${r.status} ${await r.text()}`))
            .catch((e) => process.stdout.write(`000 ${e}`));' "$1" "$2" "${3:-}" "${4:-}"
}

# access token for a seeded user (scripts/seed-users.sh: password "password", TTL 60 s)
token() {
    docker exec "$(first bnpb-auth)" node -e '
        fetch("http://localhost:3000/auth/login", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: process.argv[1], password: process.argv[2] }) })
            .then((r) => r.json()).then((j) => process.stdout.write(j.data?.accessToken ?? ""));' "$1" "${2:-password}"
}

# mongosh as root on the router: mongo_eval '<js>' (prints result of the last expression)
mongo_eval() {
    docker exec "$(first canonical-store)" sh -c \
        'mongosh "mongodb://$MONGO_INITDB_ROOT_USERNAME:$MONGO_INITDB_ROOT_PASSWORD@localhost:27017/$CANONICAL_STORE_DB_NAME?authSource=admin" --quiet --eval "$1"' \
        _ "$1" 2>/dev/null | tr -d '\r'
}
# psql in the PVMBG mock database: mock_sql '<sql>' (unaligned, tuples only)
mock_sql() {
    docker exec "$(first pvmbg-store)" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$1"' _ "$1" | tr -d '\r'
}

jget() {
    node -e '
        let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
            try { const v = process.argv[1].split(".").reduce((o, k) => (o == null ? undefined : o[k]), JSON.parse(s));
                  console.log(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : v); } catch { console.log(""); } });' "$1"
}

wait_until() {
    local description=$1 timeout=$2
    shift 2
    local start=$SECONDS
    until "$@"; do
        if (( SECONDS - start > timeout )); then
            info "TIMEOUT (${timeout}s): $description"
            return 1
        fi
        sleep 1
    done
}

# leader = replica whose instanceId owns the background lease
leader() {
    local c
    for c in $(containers bnpb-aggregator); do
        agg "$c" GET /internal/leadership | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.exit(j.lease&&j.lease.ownerId===j.instanceId?0:1)}catch{process.exit(1)}})' \
            && { echo "$c"; return 0; }
    done
    return 1
}
has_leader() { leader >/dev/null; }

# metric value summed over matching series on one container: metric <container> <regex>
metric() {
    agg "$1" GET /metrics | { grep -E "^$2" || true; } | awk '{s+=$NF} END {printf "%d\n", s}'
}

# every fault/effect must be visible, otherwise the run FAILS instead of passing vacuously
CHECKS_OK=()
CHECKS_FAIL=()
check() {
    local description=$1
    shift
    if "$@"; then CHECKS_OK+=("$description"); info "OK    $description"
    else CHECKS_FAIL+=("$description"); info "GAGAL $description"; fi
}
summary() {
    local f
    echo '== Pemeriksaan =='
    for f in "${CHECKS_OK[@]}"; do echo "  OK    $f"; done
    for f in "${CHECKS_FAIL[@]}"; do echo "  GAGAL $f"; done
    if (( ${#CHECKS_FAIL[@]} == 0 )); then echo 'HASIL AKHIR: PASS'; else echo "HASIL AKHIR: FAIL (${#CHECKS_FAIL[@]} gagal)"; fi
}

# build first, then up with retries: 10 mongod booting together on Docker Desktop 3.7 GiB can miss a healthcheck
stack_up() {
    "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    # build every image (dependencies such as canonical-store-migrate included); layers come from the shared cache
    "${compose[@]}" build --quiet
    local attempt
    for attempt in 1 2 3; do
        if "${compose[@]}" up -d "$@"; then return 0; fi
        info "compose up gagal (percobaan $attempt); coba lagi"
        sleep 10
    done
    return 1
}
