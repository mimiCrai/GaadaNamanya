// P4 #4: from Prometheus, report p95 end-to-end latency, peak lag, and how long the system took to catch up after a burst
// Usage: node scripts/satellite/p4-lag-report.mjs --start <ISO> --burst-end <ISO> [--end <ISO>] [--prometheus URL] [--out file]
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), [])
);
const prometheus = args.prometheus ?? 'http://localhost:9090';
const start = Date.parse(args.start ?? '');
const burstEnd = Date.parse(args['burst-end'] ?? '');
const end = Date.parse(args.end ?? new Date().toISOString());
if (!Number.isFinite(start) || !Number.isFinite(burstEnd) || burstEnd < start || end < burstEnd) {
    console.error('Usage: --start <ISO> --burst-end <ISO> [--end <ISO>] [--prometheus URL] [--out file]');
    process.exit(2);
}
const CATCH_UP_LIMIT_S = Number(args['catch-up-limit'] ?? 60);
const LAG_ZERO = Number(args['lag-threshold'] ?? 2);

const QUERIES = {
    behind: 'max(bnpb_aggregator_satellite_latest_offset) - max(bnpb_fire_processor_last_feed_offset)',
    unread: 'max(bnpb_fire_processor_kafka_lag_messages)',
    ingest: 'max(bnpb_aggregator_satellite_lag_offsets)',
    eventLagMinutes: '(max(bnpb_aggregator_satellite_last_heartbeat_virtual_now_seconds) - max(bnpb_fire_processor_virtual_now_seconds)) / 60',
};

async function range(query) {
    const url = new URL('/api/v1/query_range', prometheus);
    url.search = new URLSearchParams({ query, start: String(start / 1000), end: String(end / 1000), step: '1' }).toString();
    const body = await (await fetch(url)).json();
    if (body.status !== 'success') throw new Error(`Prometheus: ${JSON.stringify(body).slice(0, 300)}`);
    return (body.data.result[0]?.values ?? []).map(([t, v]) => [Number(t) * 1000, Number(v)]);
}

async function instant(query, at) {
    const url = new URL('/api/v1/query', prometheus);
    url.search = new URLSearchParams({ query, time: String(at / 1000) }).toString();
    const body = await (await fetch(url)).json();
    return Number(body.data?.result?.[0]?.value?.[1] ?? NaN);
}

const windowS = Math.max(1, Math.round((end - start) / 1000));
const series = Object.fromEntries(await Promise.all(Object.entries(QUERIES).map(async ([name, q]) => [name, await range(q)])));
const p95 = await instant(`histogram_quantile(0.95, sum by (le) (increase(bnpb_fire_processor_end_to_end_seconds_bucket[${windowS}s])))`, end);
const p50 = await instant(`histogram_quantile(0.5, sum by (le) (increase(bnpb_fire_processor_end_to_end_seconds_bucket[${windowS}s])))`, end);
// processing only: from the record whose change was applied, without the wait as a single detection
const processingP95 = await instant(`histogram_quantile(0.95, sum by (le) (increase(bnpb_fire_processor_processing_seconds_bucket[${windowS}s])))`, end);
const processed = await instant(`sum(increase(bnpb_fire_processor_records_total[${windowS}s]))`, end);

const peak = (values) => values.reduce((max, [, v]) => (Number.isFinite(v) && v > max ? v : max), 0);
// first moment after the burst from which "behind" and "unread" both stay at or below the threshold
function caughtUpAt() {
    const behind = new Map(series.behind.map(([t, v]) => [t, v]));
    const after = series.unread.filter(([t]) => t >= burstEnd);
    let candidate = null;
    for (const [t, unread] of after) {
        const ok = unread <= LAG_ZERO && (behind.get(t) ?? 0) <= LAG_ZERO;
        if (ok && candidate === null) candidate = t;
        if (!ok) candidate = null;
    }
    return candidate;
}
const caughtUp = caughtUpAt();
const catchUpSeconds = caughtUp === null ? null : Math.max(0, (caughtUp - burstEnd) / 1000);

const report = [
    `window            ${new Date(start).toISOString()} .. ${new Date(end).toISOString()} (burst ends ${new Date(burstEnd).toISOString()})`,
    `records processed ${processed}`,
    `end-to-end p50    ${p50.toFixed(3)} s`,
    `end-to-end p95    ${p95.toFixed(3)} s`,
    `processing p95    ${processingP95.toFixed(3)} s`,
    `peak behind feed  ${peak(series.behind)} offsets`,
    `peak unread       ${peak(series.unread)} records in satellite.raw`,
    `peak ingest lag   ${peak(series.ingest)} offsets`,
    `peak event lag    ${peak(series.eventLagMinutes).toFixed(1)} virtual minutes`,
    `caught up after   ${catchUpSeconds === null ? 'never (in window)' : `${catchUpSeconds.toFixed(0)} s`} (limit ${CATCH_UP_LIMIT_S} s)`,
    '',
    catchUpSeconds !== null && catchUpSeconds <= CATCH_UP_LIMIT_S ? 'PASS' : 'FAIL',
].join('\n');
console.log(report);
if (args.out) {
    writeFileSync(args.out, `${report}\n`);
    writeFileSync(args.out.replace(/\.txt$/, '') + '.series.json', JSON.stringify(series));
}
process.exit(report.endsWith('PASS') ? 0 : 1);
