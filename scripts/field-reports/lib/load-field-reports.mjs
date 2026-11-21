// P3 #6 load generator and verifier for POST /field-reports (used by scripts/field-reports/p3-field-report-proof.sh).
//   node load-field-reports.mjs load    → sends reports, appends every 202 to <OUT>/accepted.ndjson right away
//   node load-field-reports.mjs verify  → reads the store through the Aggregator and checks every 202 against it
// Runs inside a node:22 container on the Compose network; configuration via environment variables.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const env = (key, fallback) => process.env[key] ?? fallback;
const OUT = env('OUT_DIR', '/work/out');
const ACCEPTED = `${OUT}/accepted.ndjson`;
const IDS = `${OUT}/ids.json`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

// access token TTL is 60 s: refresh 15 s before exp, fall back to login, renew on 401
class Session {
    constructor(authUrl, email, password) {
        Object.assign(this, { authUrl, email, password, access: null, refresh: null, exp: 0, renewing: null });
        this.stats = { logins: 0, refreshes: 0, unauthorized: 0 };
    }
    async token() {
        if (!this.access || Date.now() > this.exp - 15_000) await this.renew();
        return this.access;
    }
    renew() {
        this.renewing ??= this.doRenew().finally(() => (this.renewing = null));
        return this.renewing;
    }
    async doRenew() {
        for (let attempt = 1; ; attempt++) {
            try {
                const viaRefresh = Boolean(this.refresh);
                const response = await fetch(`${this.authUrl}/auth/${viaRefresh ? 'refresh' : 'login'}`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(viaRefresh ? { refreshToken: this.refresh } : { email: this.email, password: this.password }),
                    signal: AbortSignal.timeout(5_000),
                });
                if (!response.ok) {
                    if (viaRefresh) { this.refresh = null; continue; }
                    throw new Error(`login HTTP ${response.status}`);
                }
                const { data } = await response.json();
                this.access = data.accessToken;
                this.refresh = data.refreshToken ?? null;
                this.exp = JSON.parse(Buffer.from(this.access.split('.')[1], 'base64url').toString()).exp * 1000;
                this.stats[viaRefresh ? 'refreshes' : 'logins']++;
                return;
            } catch (error) {
                if (attempt >= 30) throw error;
                await sleep(500);
            }
        }
    }
}

async function load() {
    const API = env('API_URL', 'http://bnpb-client-api:3000');
    const COUNT = Number(env('COUNT', 500));
    const CONCURRENCY = Number(env('CONCURRENCY', 50));
    const RESEND_RATIO = Number(env('RESEND_RATIO', 0.2));
    const CONFLICTS = Number(env('CONFLICTS', 10));
    const DURATION_MS = Number(env('DURATION_S', 90)) * 1000;
    const MAX_ATTEMPTS = Number(env('MAX_ATTEMPTS', 240));
    const session = new Session(env('AUTH_URL', 'http://bnpb-auth:3000'), env('EMAIL', 'lapangan@example.test'), env('PASSWORD', 'password'));

    const types = ['SEISMIC', 'VOLCANIC', 'WILDFIRE', 'COASTAL', 'OTHER'];
    const severities = ['NORMAL', 'WASPADA', 'SIAGA', 'AWAS'];
    const reports = Array.from({ length: COUNT }, (_, i) => ({
        report_id: randomUUID(),
        hazard_type: pick(types),
        latitude: Number((-11 + Math.random() * 17).toFixed(5)),
        longitude: Number((95 + Math.random() * 46).toFixed(5)),
        description: `Laporan uji P3 #6 nomor ${i + 1}: ${randomUUID().slice(0, 8)}`,
        severity_estimate: pick(severities),
        reported_at: new Date().toISOString(),
    }));
    const conflictIds = new Set(reports.slice().sort(() => Math.random() - 0.5).slice(0, CONFLICTS).map((r) => r.report_id));
    writeFileSync(IDS, JSON.stringify({ ids: reports.map((r) => r.report_id), conflict_ids: [...conflictIds] }));

    const start = Date.now();
    const tasks = reports.map((body, i) => ({ kind: 'first', body, due: start + Math.floor((i * DURATION_MS) / COUNT) }));
    const stats = { attempts: 0, accepted: 0, status: {}, network: 0, retries: 0, resends: 0, conflicts_sent: 0, gave_up: 0, inflight: 0, done: false };
    const latencies = [];
    let pending = tasks.length;

    const progress = () => {
        const tmp = `${OUT}/progress.json.tmp`;
        writeFileSync(tmp, JSON.stringify({ ...stats, ...session.stats, pending, elapsed_ms: Date.now() - start }));
        renameSync(tmp, `${OUT}/progress.json`);
    };
    const ticker = setInterval(progress, 500);

    const schedule = (task) => { tasks.push(task); pending++; };
    const next = () => {
        if (tasks.length === 0) return null;
        let best = 0;
        for (let i = 1; i < tasks.length; i++) if (tasks[i].due < tasks[best].due) best = i;
        return tasks.splice(best, 1)[0];
    };

    async function send(task) {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (attempt > 1) stats.retries++;
            stats.attempts++;
            stats.inflight++;
            const t0 = performance.now();
            let status = 0;
            let retryAfter = 0;
            let body = null;
            try {
                const response = await fetch(`${API}/field-reports`, {
                    method: 'POST',
                    headers: { authorization: `Bearer ${await session.token()}`, 'content-type': 'application/json' },
                    body: JSON.stringify(task.body),
                    signal: AbortSignal.timeout(10_000),
                });
                status = response.status;
                retryAfter = Number(response.headers.get('retry-after') ?? 0);
                body = await response.json().catch(() => null);
            } catch {
                stats.network++;
            } finally {
                stats.inflight--;
            }
            const latencyMs = Number((performance.now() - t0).toFixed(2));
            if (status) stats.status[status] = (stats.status[status] ?? 0) + 1;
            if (status === 202) {
                // durable record of every 202 BEFORE anything else happens to it (gap: "202 only in memory")
                appendFileSync(ACCEPTED, `${JSON.stringify({ t: new Date().toISOString(), kind: task.kind, attempt, latency_ms: latencyMs, accepted_at: body?.accepted_at ?? null, report_id: task.body.report_id, content_sha256: sha(task.body), body: task.body })}\n`);
                stats.accepted++;
                latencies.push(latencyMs);
                return true;
            }
            if (status === 401) { session.stats.unauthorized++; await session.renew().catch(() => undefined); continue; }
            if (status >= 400 && status < 500) return false;
            await sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(2_000, 100 * 2 ** Math.min(attempt, 5)));
        }
        stats.gave_up++;
        return false;
    }

    async function worker() {
        while (pending > 0) {
            const task = next();
            if (!task) { await sleep(20); continue; }
            const wait = task.due - Date.now();
            if (wait > 0) await sleep(wait);
            const ok = await send(task);
            if (ok && task.kind === 'first') {
                if (Math.random() < RESEND_RATIO) { stats.resends++; schedule({ kind: 'resend', body: task.body, due: Date.now() + 500 + Math.random() * 8_000 }); }
                if (conflictIds.has(task.body.report_id)) {
                    stats.conflicts_sent++;
                    schedule({ kind: 'conflict', body: { ...task.body, description: `${task.body.description} [koreksi: isi berbeda]` }, due: Date.now() + 500 + Math.random() * 4_000 });
                }
            }
            pending--;
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    clearInterval(ticker);
    stats.done = true;
    progress();
    const sorted = latencies.slice().sort((a, b) => a - b);
    const summary = {
        reports: COUNT, concurrency: CONCURRENCY, duration_ms: Date.now() - start,
        accepted_202: stats.accepted, status: stats.status, network_errors: stats.network, retries_after_failure: stats.retries,
        intentional_resends: stats.resends, conflicts_sent: stats.conflicts_sent, gave_up: stats.gave_up, ...session.stats,
        latency_ms: { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.at(-1) ?? null },
    };
    writeFileSync(`${OUT}/load-summary.json`, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
}

async function verify() {
    const GATEWAY = env('GATEWAY_URL', 'http://bnpb-aggregator-entry:3000');
    const headers = { 'X-BNPB-Internal-Key': env('INTERNAL_KEY') };
    const problems = [];
    const notes = [];
    const retriedReads = [];
    // gap "partial read": a partial or non-200 answer is never accepted; re-read up to 5 times, then FAIL
    const get = async (path) => {
        let last = 'tidak ada jawaban';
        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                const response = await fetch(`${GATEWAY}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
                const body = await response.json().catch(() => null);
                if (response.ok && body && body.partial !== true) return body;
                last = `HTTP ${response.status} partial=${body?.partial} unavailable_units=${JSON.stringify(body?.unavailable_units ?? [])}`;
            } catch (error) {
                last = String(error);
            }
            retriedReads.push(`GET ${path} percobaan ${attempt}: ${last}`);
            await sleep(3_000);
        }
        problems.push(`baca tidak lengkap setelah 5 percobaan: GET ${path} → ${last}`);
        return {};
    };

    const { ids, conflict_ids: conflictIds } = JSON.parse(readFileSync(IDS, 'utf8'));
    const attempted = new Set(ids);
    const conflicts = new Set(conflictIds);
    const lines = existsSync(ACCEPTED) ? readFileSync(ACCEPTED, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const firstAccepted = new Map();
    const conflictAccepted = new Set();
    for (const line of lines) {
        if (line.kind === 'first' && !firstAccepted.has(line.report_id)) firstAccepted.set(line.report_id, line.body);
        if (line.kind === 'conflict') conflictAccepted.add(line.report_id);
    }
    const acceptedIds = new Set(lines.map((l) => l.report_id));

    const stored = new Map();
    const occurrences = new Map();
    let after = null;
    let pages = 0;
    do {
        const page = await get(`/internal/field-reports?limit=1000${after ? `&after=${after}` : ''}`);
        for (const item of page.items ?? []) {
            occurrences.set(item.report_id, (occurrences.get(item.report_id) ?? 0) + 1);
            stored.set(item.report_id, item);
        }
        after = page.next_after ?? null;
        pages++;
    } while (after && pages < 100);

    let mismatched = 0;
    let missing = 0;
    let duplicated = 0;
    for (const id of acceptedIds) {
        const item = stored.get(id);
        if (!item) { missing++; problems.push(`202 tetapi tidak tersimpan: ${id}`); continue; }
        if (occurrences.get(id) !== 1) { duplicated++; problems.push(`tersimpan ${occurrences.get(id)}× : ${id}`); }
        // conflicts: the first send (smaller offset in the same partition) must win
        const expected = firstAccepted.get(id);
        if (!expected) { problems.push(`tidak ada 202 kiriman pertama untuk ${id}`); continue; }
        const same = item.hazard_type === expected.hazard_type && item.latitude === expected.latitude && item.longitude === expected.longitude
            && item.description === expected.description && item.severity_estimate === expected.severity_estimate
            && Date.parse(item.reported_at) === Date.parse(expected.reported_at);
        if (!same) { mismatched++; problems.push(`isi berbeda dari kiriman pertama: ${id}`); }
    }
    const phantoms = [...stored.keys()].filter((id) => !attempted.has(id));
    for (const id of phantoms) problems.push(`dokumen fantom (tidak pernah dikirim): ${id}`);
    const storedWithout202 = [...stored.keys()].filter((id) => attempted.has(id) && !acceptedIds.has(id));
    if (storedWithout202.length) notes.push(`${storedWithout202.length} laporan tersimpan tanpa 202 (publish sukses tetapi balasan hilang/timeout; at-least-once)`);
    if (retriedReads.length) notes.push(`${retriedReads.length} pembacaan partial/non-200 diulang: ${retriedReads.slice(0, 3).join(' | ')}`);

    // gap "DLQ swallows reports": every DLQ entry must be an expected conflict
    const dlq = [];
    let cursor = null;
    do {
        const page = await get(`/internal/dlq?source=FIELD_REPORT&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        dlq.push(...(page.items ?? []));
        cursor = page.next_cursor ?? null;
    } while (cursor);
    const dlqConflictIds = new Set();
    for (const entry of dlq) {
        if (entry.category === 'conflict' && conflicts.has(entry.source_ref_id)) dlqConflictIds.add(entry.source_ref_id);
        else problems.push(`entri DLQ tak terduga: ${entry.message_id} ${entry.category} ${entry.source_ref_id} — ${entry.reason}`);
    }
    for (const id of conflictAccepted) if (!dlqConflictIds.has(id)) problems.push(`kiriman konflik berbalas 202 tidak tercatat di DLQ: ${id}`);

    const deliveries = [...stored.values()].map((i) => i.deliveries ?? 1);
    const result = {
        accepted_lines: lines.length, accepted_ids: acceptedIds.size, stored: stored.size, missing, duplicated, mismatched,
        phantoms: phantoms.length, stored_without_202: storedWithout202.length,
        conflict_ids: conflicts.size, conflict_202: conflictAccepted.size, dlq_entries: dlq.length, dlq_conflicts: dlqConflictIds.size,
        max_deliveries: Math.max(0, ...deliveries), redelivered_docs: deliveries.filter((d) => d > 1).length,
        problems, notes, pass: problems.length === 0,
    };
    writeFileSync(`${OUT}/verify.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, problems: problems.slice(0, 20) }));
    process.exit(result.pass ? 0 : 1);
}

const mode = process.argv[2];
if (mode === 'load') await load();
else if (mode === 'verify') await verify();
else { console.error('pemakaian: load-field-reports.mjs load|verify'); process.exit(2); }
