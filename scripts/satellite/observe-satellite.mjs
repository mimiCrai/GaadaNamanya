import { mkdirSync, writeFileSync, appendFileSync, openSync, closeSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE_URL = process.env.SATELLITE_BASE_URL ?? 'https://satellite.naufarrel.dev';
const ALLOWED_PATHS = new Set(['/v1/session', '/v1/stream']);
const MAX_SECONDS = 60;

function arg(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : fallback;
}

const token = process.env.SATELLITE_TOKEN;
if (!token) {
    console.error('SATELLITE_TOKEN belum di-set');
    process.exit(2);
}
const from = arg('from', '0');
const seconds = Math.min(Number(arg('seconds', String(MAX_SECONDS))), MAX_SECONDS);
const outDir = arg('out', 'tests/fixtures/satellite');
mkdirSync(outDir, { recursive: true });

function guardedUrl(pathname, query = {}) {
    if (!ALLOWED_PATHS.has(pathname)) throw new Error(`Path ${pathname} tidak diizinkan`);
    const url = new URL(pathname, BASE_URL);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
}

const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'bnpb-satellite-observer/1.0' };

// ---- lock: satu koneksi stream per mesin ----
const lockPath = path.join(tmpdir(), 'bnpb-satellite-stream.lock');
let lockFd;
try {
    lockFd = openSync(lockPath, 'wx');
    writeFileSync(lockFd, String(process.pid));
} catch {
    const holder = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '?';
    console.error(`Lock ${lockPath} dipegang PID ${holder}. Hapus manual hanya jika yakin tidak ada stream lain.`);
    process.exit(3);
}
const releaseLock = () => {
    try {
        closeSync(lockFd);
        unlinkSync(lockPath);
    } catch {
        /* sudah dilepas */
    }
};
process.on('exit', releaseLock);
process.on('SIGINT', () => process.exit(130));

// ---- 1. session ----
const sessionStartedWall = Date.now();
const sessionResponse = await fetch(guardedUrl('/v1/session'), { headers });
const sessionText = await sessionResponse.text();
const sessionReceivedWall = Date.now();
writeFileSync(
    path.join(outDir, 'session.json'),
    JSON.stringify(
        {
            observed_at_wall: new Date(sessionReceivedWall).toISOString(),
            rtt_ms: sessionReceivedWall - sessionStartedWall,
            status: sessionResponse.status,
            body: safeJson(sessionText),
        },
        null,
        2
    ) + '\n'
);
console.log(`session HTTP ${sessionResponse.status}: ${sessionText}`);
if (!sessionResponse.ok) process.exit(1);

// ---- 2. stream (satu koneksi) ----
const rawPath = path.join(outDir, 'stream-raw.ndjson');
writeFileSync(rawPath, '');
const samples = {};
const SAMPLES_PER_TYPE = 5;
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), seconds * 1000);
const streamStartedWall = Date.now();
let count = 0;
let firstId = null;
let lastId = null;

try {
    const response = await fetch(guardedUrl('/v1/stream', { from }), {
        headers: { ...headers, Accept: 'text/event-stream' },
        signal: controller.signal,
    });
    console.log(`stream HTTP ${response.status} content-type=${response.headers.get('content-type')}`);
    if (!response.ok) {
        const body = await response.text();
        writeFileSync(path.join(outDir, `stream-error-${response.status}.json`), body + '\n');
        console.log(body);
        process.exit(1);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let separator;
        while ((separator = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const block = buffer.slice(0, separator);
            buffer = buffer.slice(separator).replace(/^\r?\n\r?\n/, '');
            if (block.trim() === '') continue;
            handleBlock(block, Date.now());
        }
    }
} catch (error) {
    if (error.name !== 'AbortError') throw error;
} finally {
    clearTimeout(deadline);
}

for (const [type, blocks] of Object.entries(samples)) {
    writeFileSync(path.join(outDir, `${type}.sse`), blocks.join('\n\n') + '\n\n');
}
const summary = {
    from,
    seconds,
    stream_started_wall: new Date(streamStartedWall).toISOString(),
    events: count,
    first_id: firstId,
    last_id: lastId,
    types: Object.fromEntries(Object.entries(samples).map(([type, list]) => [type, list.length])),
};
writeFileSync(path.join(outDir, 'stream-summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));

function handleBlock(block, receivedWall) {
    const fields = { id: null, event: 'message', data: [], other: [] };
    for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(':')) {
            fields.other.push(line);
            continue;
        }
        const colon = line.indexOf(':');
        const name = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (name === 'id') fields.id = value;
        else if (name === 'event') fields.event = value;
        else if (name === 'data') fields.data.push(value);
        else fields.other.push(line);
    }
    count++;
    if (fields.id !== null) {
        firstId ??= fields.id;
        lastId = fields.id;
    }
    const dataText = fields.data.join('\n');
    appendFileSync(
        rawPath,
        JSON.stringify({
            received_wall: new Date(receivedWall).toISOString(),
            id: fields.id,
            event: fields.event,
            data: safeJson(dataText),
            other: fields.other,
        }) + '\n'
    );
    const list = (samples[fields.event] ??= []);
    if (list.length < SAMPLES_PER_TYPE) list.push(block);
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
