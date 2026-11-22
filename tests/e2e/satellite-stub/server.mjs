// Local stand-in for the assistant's satellite feed, for scripts/satellite/p4-reconnect-test.sh (P4 #8) only.
// It mimics the observed contract: GET /v1/session, GET /v1/stream?from=<offset>
// (inclusive; Last-Event-ID = last received id), Bearer auth, offsets shared by all event types, heartbeats with
// virtual_now, errors {"error":{"code","message"}} with 400/401/429/503, and ONE stream connection at a time.
// Faults are injected through /admin/* so the test is deterministic and repeatable.
// It deliberately has no /v1/exam/start or /v1/video.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 8090);
const TOKEN = process.env.STUB_TOKEN ?? 'stub-satellite-token-0123456789';
const LAST_OFFSET = Number(process.env.STUB_LAST_OFFSET ?? 1200);
const INTERVAL_MS = Number(process.env.STUB_INTERVAL_MS ?? 40);
const HEARTBEAT_EVERY = Number(process.env.STUB_HEARTBEAT_EVERY ?? 17);
const IDLE_COMMENT_MS = Number(process.env.STUB_IDLE_COMMENT_MS ?? 5_000);
// spread of detections in degrees; small values cluster them into fires (crash-equivalence test)
const SPREAD_DEG = Number(process.env.STUB_SPREAD_DEG ?? 2);
const MALFORMED = new Set(
    (process.env.STUB_MALFORMED_OFFSETS ?? '133,377')
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value >= 0)
);
const START_VIRTUAL = Date.parse('2026-11-15T00:00:00Z');
const VIRTUAL_MS_PER_OFFSET = 60_000;
let startedAt = null;

const state = {
    active: null, // { res, id }
    nextConnectionId: 1,
    faults: { status: null, statusCount: 0, dropNow: false, skipNext: false },
    stats: { connections: 0, responses: {}, froms: [], skipped: [], dropped: 0 },
};

/** Offsets 0..published() exist in the feed's timeline (backlog is sent at once, newer ones as they appear). */
function published() {
    if (startedAt === null) return -1;
    return Math.min(LAST_OFFSET, Math.floor((Date.now() - startedAt) / INTERVAL_MS));
}

function rng(seed) {
    let a = (seed * 2654435761) >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function kindOf(offset) {
    if (offset % HEARTBEAT_EVERY === HEARTBEAT_EVERY - 1) return 'heartbeat';
    if (offset % 97 === 50) return 'update';
    if (offset % 131 === 70) return 'retract';
    return 'detection';
}

/** Exact data bytes of one offset, deterministic, written by hand so numbers keep trailing zeros (367.0). */
function dataOf(offset) {
    if (MALFORMED.has(offset)) {
        return offset % 2 === 0
            ? Buffer.from(`{"offset":${offset},"detection":{"satellite":"N2`)
            : Buffer.concat([Buffer.from(`{"offset":${offset},"detection":{"satellite":"`), Buffer.from([0xc3, 0x28]), Buffer.from('"}}')]);
    }
    const random = rng(offset + 1);
    const virtualMs = START_VIRTUAL + offset * VIRTUAL_MS_PER_OFFSET;
    const kind = kindOf(offset);
    if (kind === 'heartbeat') {
        return Buffer.from(`{"offset":${offset},"virtual_now":"${new Date(virtualMs).toISOString().replace('.000', '')}"}`);
    }
    // Detection time lags the virtual clock by 1..90 minutes (out of order, like the real feed).
    const acq = new Date(virtualMs - (1 + Math.floor(random() * 90)) * 60_000);
    const acqDate = acq.toISOString().slice(0, 10);
    const acqTime = acq.getUTCHours() * 100 + acq.getUTCMinutes();
    const satellite = ['N', 'N20', 'N21'][Math.floor(random() * 3)];
    const confidence = ['l', 'n', 'h'][Math.floor(random() * 3)];
    const lat = (-3 + random() * SPREAD_DEG).toFixed(5);
    const lon = (113 + random() * SPREAD_DEG).toFixed(5);
    const frp = (random() * 40).toFixed(2);
    const ti4 = (300 + Math.floor(random() * 70)).toFixed(1);
    const detection = `{"version":"2.0NRT","scan":0.39,"acq_date":"${acqDate}","acq_time":${acqTime},"bright_ti4":${ti4},"bright_ti5":291.91,"confidence":"${confidence}","daynight":"D","frp":${frp},"instrument":"VIIRS","latitude":${lat},"longitude":${lon},"satellite":"${satellite}","track":0.37}`;
    if (kind === 'retract') return Buffer.from(`{"offset":${offset},"detection_key":"${satellite}|${acqDate}|${acqTime}|${lat}|${lon}"}`);
    return Buffer.from(`{"offset":${offset},"detection":${detection}}`);
}

function blockOf(offset) {
    const eol = offset % 3 === 0 ? '\r\n' : '\n';
    return Buffer.concat([
        Buffer.from(`id: ${offset}${eol}event: ${kindOf(offset)}${eol}data: `),
        dataOf(offset),
        Buffer.from(`${eol}${eol}`),
    ]);
}

function expected() {
    const offsets = [];
    for (let offset = 0; offset <= LAST_OFFSET; offset++) {
        offsets.push({
            offset,
            kind: MALFORMED.has(offset) ? 'unprocessed' : kindOf(offset),
            sha256: createHash('sha256').update(dataOf(offset)).digest('hex'),
        });
    }
    return { last_offset: LAST_OFFSET, malformed: [...MALFORMED].sort((a, b) => a - b), offsets };
}

// ------------------------------------------------------------------ HTTP

function send(res, status, body) {
    state.stats.responses[status] = (state.stats.responses[status] ?? 0) + 1;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

function error(res, status, code, message) {
    send(res, status, { error: { code, message } });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function write(res, bytes) {
    if (res.destroyed) return false;
    if (!res.write(bytes)) await new Promise((resolve) => res.once('drain', resolve).once('close', resolve));
    return !res.destroyed;
}

/** Writes one block in 1–3 random pieces so the client sees events cut mid-line (and CR|LF split). */
async function writeBlock(res, offset, random) {
    const bytes = blockOf(offset);
    const cuts = [0];
    const pieces = 1 + Math.floor(random() * 3);
    for (let i = 1; i < pieces; i++) cuts.push(1 + Math.floor(random() * (bytes.length - 1)));
    cuts.push(bytes.length);
    cuts.sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
        if (!(await write(res, bytes.subarray(cuts[i], cuts[i + 1])))) return false;
        if (i < cuts.length - 2) await new Promise((resolve) => setImmediate(resolve));
    }
    return true;
}

async function stream(req, res, from) {
    const id = state.nextConnectionId++;
    state.active = { res, id };
    startedAt ??= Date.now();
    state.stats.connections++;
    state.stats.froms.push(from);
    state.stats.responses[200] = (state.stats.responses[200] ?? 0) + 1;
    res.on('close', () => {
        if (state.active?.id === id) state.active = null;
    });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const random = rng(id * 7919);
    if (!(await write(res, ': stub satellite feed\nretry: 1000\n\n'))) return;

    let offset = from;
    let lastWrite = Date.now();
    while (!res.destroyed) {
        if (state.faults.dropNow) {
            state.faults.dropNow = false;
            state.stats.dropped++;
            const half = blockOf(Math.min(offset, LAST_OFFSET));
            await write(res, half.subarray(0, Math.floor(half.length / 2))); // die mid-event
            res.destroy();
            return;
        }
        if (offset > LAST_OFFSET || offset > published()) {
            if (Date.now() - lastWrite >= IDLE_COMMENT_MS) {
                if (!(await write(res, ': idle\n\n'))) return;
                lastWrite = Date.now();
            }
            await sleep(Math.min(INTERVAL_MS, 50));
            continue;
        }
        if (state.faults.skipNext) {
            state.faults.skipNext = false;
            state.stats.skipped.push(offset);
            offset++; // a gap on this connection only; a reconnect gets it again
            continue;
        }
        if (!(await writeBlock(res, offset, random))) return;
        lastWrite = Date.now();
        offset++;
        await sleep(offset <= published() ? 1 : 0); // backlog flows fast, live events as they appear
    }
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    try {
        if (url.pathname === '/health') return send(res, 200, { status: 'ok' });

        if (url.pathname.startsWith('/admin/')) {
            if (req.method === 'GET' && url.pathname === '/admin/expected') return send(res, 200, expected());
            if (req.method === 'GET' && url.pathname === '/admin/stats') {
                return send(res, 200, { ...state.stats, active: Boolean(state.active), published: published() });
            }
            if (req.method === 'POST' && url.pathname === '/admin/fault') {
                let body = '';
                for await (const chunk of req) body += chunk;
                const fault = body ? JSON.parse(body) : {};
                if (fault.drop_now) state.faults.dropNow = true;
                if (fault.skip_next) state.faults.skipNext = true;
                if (fault.status) {
                    state.faults.status = Number(fault.status);
                    state.faults.statusCount = Number(fault.count ?? 1);
                }
                if (fault.kill_active && state.active) state.active.res.destroy();
                return send(res, 200, { ok: true, faults: state.faults });
            }
            return error(res, 404, 'not_found', 'admin endpoint tidak ada');
        }

        if (req.headers.authorization !== `Bearer ${TOKEN}`) return error(res, 401, 'unauthorized', 'token tidak valid');

        if (req.method === 'GET' && url.pathname === '/v1/session') {
            return send(res, 200, {
                profile: 'stub',
                speed: 60,
                group: 'stub',
                latest_offset: Math.max(published(), 0),
                virtual_now: new Date(START_VIRTUAL + Math.max(published(), 0) * VIRTUAL_MS_PER_OFFSET).toISOString().replace('.000', ''),
            });
        }

        if (req.method === 'GET' && url.pathname === '/v1/stream') {
            const fromText = url.searchParams.get('from');
            const lastEventId = req.headers['last-event-id'];
            let from = 0;
            if (fromText !== null) {
                if (!/^\d+$/.test(fromText)) return error(res, 400, 'bad_request', 'from harus bilangan bulat >= 0');
                from = Number(fromText);
            } else if (typeof lastEventId === 'string' && /^\d+$/.test(lastEventId)) {
                from = Number(lastEventId) + 1;
            }
            if (state.faults.statusCount > 0) {
                state.faults.statusCount--;
                const status = state.faults.status;
                const code = status === 429 ? 'too_many_connections' : status === 503 ? 'unavailable' : 'bad_request';
                return error(res, status, code, 'fault injected by stub');
            }
            if (state.active) return error(res, 429, 'too_many_connections', 'sudah ada koneksi stream aktif');
            return await stream(req, res, from);
        }

        return error(res, 404, 'not_found', 'endpoint tidak ada');
    } catch (failure) {
        if (!res.headersSent) error(res, 500, 'internal', String(failure));
        else res.destroy();
    }
});

server.listen(PORT, () => {
    console.log(JSON.stringify({ msg: 'satellite stub listening', port: PORT, last_offset: LAST_OFFSET, malformed: [...MALFORMED] }));
});
