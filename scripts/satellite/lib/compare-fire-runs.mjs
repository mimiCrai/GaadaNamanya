// P4 #5: compares two collected runs (clean vs crashed); prints PASS/FAIL and exits 0/1
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [cleanDir, crashDir, outFile] = process.argv.slice(2);
if (!cleanDir || !crashDir) {
    console.error('Usage: node compare-fire-runs.mjs <clean-dir> <crash-dir> [result-file]');
    process.exit(2);
}

const load = (dir, name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
// ingested_at and hazard_id are store-side; everything the processor decides must match exactly
const essence = (item) => ({
    source_ref_id: item.source_ref_id,
    hazard_type: item.hazard_type,
    severity: item.severity,
    area_name: item.area_name,
    latitude: item.latitude,
    longitude: item.longitude,
    occurred_at: item.occurred_at,
    attributes: item.attributes,
});
const COUNTERS = ['last_offset', 'detections', 'active', 'low_excluded', 'retracted', 'single_detections', 'fires', 'final_fires', 'late_detections'];

const lines = [];
const checks = [];
const check = (name, ok, detail = '') => {
    checks.push(ok);
    lines.push(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const clean = { events: load(cleanDir, 'events.json'), checksum: load(cleanDir, 'checksum.json'), summary: load(cleanDir, 'summary.json') };
const crash = { events: load(crashDir, 'events.json'), checksum: load(crashDir, 'checksum.json'), summary: load(crashDir, 'summary.json') };

check('clean run produced fires', clean.events.length > 0, `${clean.events.length} WILDFIRE HazardEvents`);
check('same number of HazardEvents', clean.events.length === crash.events.length, `${clean.events.length} vs ${crash.events.length}`);
check('checksum SATELIT identical', clean.checksum.checksum === crash.checksum.checksum, `${clean.checksum.checksum} vs ${crash.checksum.checksum}`);

const byRef = (items) => new Map(items.map((item) => [item.source_ref_id, JSON.stringify(essence(item))]));
const a = byRef(clean.events);
const b = byRef(crash.events);
const missing = [...a.keys()].filter((ref) => !b.has(ref));
const extra = [...b.keys()].filter((ref) => !a.has(ref));
const differing = [...a.keys()].filter((ref) => b.has(ref) && a.get(ref) !== b.get(ref));
check('no fire lost', missing.length === 0, missing.slice(0, 5).join(', '));
check('no fire duplicated or invented', extra.length === 0, extra.slice(0, 5).join(', '));
check('every fire identical (severity, centroid, province, attributes)', differing.length === 0, differing.slice(0, 5).join(', '));

for (const counter of COUNTERS) {
    const left = clean.summary.processor?.[counter];
    const right = crash.summary.processor?.[counter];
    check(`counter ${counter} identical`, left === right, `${left} vs ${right}`);
}
check(
    'late_detections stored identical',
    clean.summary.late_detections_stored === crash.summary.late_detections_stored,
    `${clean.summary.late_detections_stored} vs ${crash.summary.late_detections_stored}`
);
check('crash run actually restarted from a snapshot', (crash.summary.processor?.restored_from_feed_offset ?? null) !== null);

const verdict = checks.every(Boolean) ? 'PASS' : 'FAIL';
lines.push('', verdict);
const report = lines.join('\n');
console.log(report);
if (outFile) writeFileSync(outFile, `${report}\n`);
process.exit(verdict === 'PASS' ? 0 : 1);
