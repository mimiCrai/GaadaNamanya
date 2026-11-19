import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

function arg(name) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

const rawPath = arg('raw');
if (!rawPath || !existsSync(rawPath)) {
    console.error('Pemakaian: verify-satellite-raw.mjs --raw <dump> [--expected f] [--audit f] [--status f] [--latest n]');
    process.exit(2);
}

const records = [];
let unreadable = 0;
for (const line of readFileSync(rawPath, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const separator = line.indexOf('|');
    if (separator < 0) {
        unreadable++;
        continue;
    }
    const key = line.slice(0, separator);
    try {
        records.push({ key, value: JSON.parse(line.slice(separator + 1)) });
    } catch {
        unreadable++;
    }
}

const counts = new Map();
let keyMismatch = 0;
let orderViolations = 0;
let previous = null;
for (const { key, value } of records) {
    const offset = Number(key);
    counts.set(offset, (counts.get(offset) ?? 0) + 1);
    if (value.offset !== offset) keyMismatch++;
    if (previous !== null && offset !== previous + 1) orderViolations++;
    previous = offset;
}
const offsets = [...counts.keys()].sort((a, b) => a - b);
const min = offsets.length ? offsets[0] : null;
const max = offsets.length ? offsets[offsets.length - 1] : null;
const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([offset, n]) => ({ offset, extra: n - 1 }));
const duplicateCount = duplicates.reduce((sum, d) => sum + d.extra, 0);
const missing = [];
if (max !== null) for (let offset = 0; offset <= max; offset++) if (!counts.has(offset)) missing.push(offset);

const kinds = {};
for (const { value } of records) kinds[value.kind] = (kinds[value.kind] ?? 0) + 1;
const unprocessed = records.filter((r) => r.value.kind === 'unprocessed');

const failures = [];
if (records.length === 0) failures.push('satellite.raw kosong');
if (unreadable > 0) failures.push(`${unreadable} baris tidak terbaca`);
if (missing.length > 0) failures.push(`${missing.length} celah`);
if (duplicateCount > 0) failures.push(`${duplicateCount} duplikat`);
if (keyMismatch > 0) failures.push(`${keyMismatch} record dengan key ≠ value.offset`);
if (orderViolations > 0) failures.push(`${orderViolations} pelanggaran urutan log`);

let contentLine = null;
const expectedPath = arg('expected');
if (expectedPath) {
    const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
    const byOffset = new Map(records.map((r) => [Number(r.key), r.value]));
    let matched = 0;
    const wrong = [];
    for (const entry of expected.offsets) {
        const got = byOffset.get(entry.offset);
        if (!got) continue; // counted as a gap / incomplete below
        const ok =
            entry.kind === 'unprocessed'
                ? got.kind === 'unprocessed'
                : got.kind === entry.kind &&
                  createHash('sha256').update(Buffer.from(got.data_raw ?? '', 'utf8')).digest('hex') === entry.sha256;
        if (ok) matched++;
        else wrong.push(entry.offset);
    }
    contentLine = `${matched}/${expected.offsets.length}${wrong.length ? ` (berbeda: ${wrong.slice(0, 10).join(', ')})` : ''}`;
    if (max !== expected.last_offset) failures.push(`stream belum lengkap: max ${max}, stub ${expected.last_offset}`);
    if (matched !== expected.offsets.length) failures.push(`isi tidak cocok dengan stub (${matched}/${expected.offsets.length})`);
}

const latest = arg('latest');
if (latest !== undefined && latest !== '' && max !== null && max < Number(latest) - 1) {
    failures.push(`belum mutakhir: max ${max}, latest_offset feed ${latest}`);
}

let auditLine = null;
const auditPath = arg('audit');
if (auditPath && existsSync(auditPath)) {
    let items = [];
    try {
        items = JSON.parse(readFileSync(auditPath, 'utf8')).items ?? [];
    } catch {
        failures.push('respons audit tidak terbaca');
    }
    const ids = new Set(items.filter((i) => i.source === 'SATELIT').map((i) => i.message_id));
    const absent = unprocessed.filter((r) => !ids.has(r.value.message_id));
    auditLine = absent.length === 0 ? 'ya' : `TIDAK (${absent.map((r) => r.key).join(', ')})`;
    if (absent.length > 0) failures.push(`${absent.length} record unprocessed tidak ada di audit`);
}

let reconnectLine = null;
const statusPath = arg('status');
if (statusPath && existsSync(statusPath)) {
    const totals = {};
    let gapsSeen = 0;
    let dupsDropped = 0;
    for (const line of readFileSync(statusPath, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            const status = JSON.parse(line);
            for (const [reason, n] of Object.entries(status.reconnects ?? {})) totals[reason] = (totals[reason] ?? 0) + n;
            gapsSeen += status.gaps ?? 0;
            dupsDropped += status.duplicates ?? 0;
        } catch {
        }
    }
    reconnectLine = `${Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(' ') || '-'}  (dibuang sbg duplikat oleh reader: ${dupsDropped}, celah terdeteksi oleh reader: ${gapsSeen})`;
}

const list = (values) => (values.length > 10 ? `${values.slice(0, 10).join(', ')}, …` : values.join(', '));
console.log('== Verifikasi satellite.raw (read_committed) ==');
console.log(`rentang offset     : ${min ?? '-'} .. ${max ?? '-'} (${records.length} record, ${offsets.length} offset unik)`);
console.log(`celah              : ${missing.length}${missing.length ? ` (${list(missing)})` : ''}`);
console.log(`duplikat           : ${duplicateCount}${duplicates.length ? ` (${list(duplicates.map((d) => d.offset))})` : ''}`);
console.log(`urutan log         : ${orderViolations === 0 ? 'naik tepat +1' : `${orderViolations} pelanggaran`}`);
console.log(`jenis record       : ${Object.entries(kinds).map(([k, v]) => `${k}=${v}`).join(' ')}`);
if (contentLine) console.log(`isi cocok dg stub  : ${contentLine}`);
console.log(
    `record unprocessed : ${unprocessed.length}${unprocessed.length ? ` (offset ${list(unprocessed.map((r) => r.key))})` : ''}${auditLine ? ` → ada di audit SATELIT: ${auditLine}` : ''}`
);
if (reconnectLine) console.log(`reconnect          : ${reconnectLine}`);
if (failures.length) console.log(`alasan gagal       : ${failures.join('; ')}`);
console.log(`HASIL: ${failures.length === 0 ? 'PASS' : 'FAIL'}`);
process.exit(failures.length === 0 ? 0 : 1);
