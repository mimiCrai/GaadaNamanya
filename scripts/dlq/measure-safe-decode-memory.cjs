const path = require('node:path');
const { createHash } = require('node:crypto');

process.env.NODE_ENV ??= 'test';
for (const [key, value] of Object.entries({
    DATABASE_URL: 'mongodb://localhost:27017/x',
    KAFKA_BROKERS: 'localhost:9092',
    BNPB_AUDIT_TOKEN: 'x'.repeat(32),
    BNPB_INTERNAL_API_KEY: 'x'.repeat(32),
    BMKG_BASE_URL: 'http://localhost:1',
    BMKG_API_KEY: 'x',
    PVMBG_BASE_URL: 'http://localhost:1',
    PVMBG_TOKEN: 'x',
})) process.env[key] ??= value;

const { readLimited } = require(path.join(__dirname, '../../services/bnpb-aggregator/dist/src/libs/safe-decode'));

const mode = process.argv[2] ?? 'limited';
const totalMiB = Number(process.argv[3] ?? 50);
const MiB = 1024 * 1024;

async function* source(total) {
    const chunk = 64 * 1024;
    for (let produced = 0; produced < total; produced += chunk) {
        yield Buffer.alloc(Math.min(chunk, total - produced), 0x61);
    }
}

async function main() {
    global.gc?.();
    const base = process.memoryUsage();
    const peak = { ...base };
    const sampler = setInterval(() => {
        const usage = process.memoryUsage();
        for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], usage[key]);
    }, 5);
    const started = Date.now();
    let result;
    if (mode === 'naive') {
        const chunks = [];
        for await (const chunk of source(totalMiB * MiB)) chunks.push(chunk);
        const all = Buffer.concat(chunks);
        result = { size: all.length, sha256: createHash('sha256').update(all).digest('hex') };
    } else {
        const hash = createHash('sha256');
        const read = await readLimited(source(totalMiB * MiB), 5 * MiB, () => ({
            write: async (chunk) => void hash.update(chunk),
            finish: async () => ({ id: 'sink' }),
            abort: async () => undefined,
        }));
        result = { kind: read.kind, size: read.size, sha256: read.sha256, sinkSha256: hash.digest('hex') };
    }
    clearInterval(sampler);
    const usage = process.memoryUsage();
    for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], usage[key]);
    const delta = (key) => Number(((peak[key] - base[key]) / MiB).toFixed(1));
    console.log(
        JSON.stringify({
            mode,
            payload_mib: totalMiB,
            elapsed_ms: Date.now() - started,
            result,
            peak_growth_mib: { rss: delta('rss'), heapUsed: delta('heapUsed'), external: delta('external'), arrayBuffers: delta('arrayBuffers') },
        })
    );
}

void main();
