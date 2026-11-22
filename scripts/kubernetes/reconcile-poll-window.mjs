import { parseArgs } from 'node:util';

const pageSize = 1000;

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Set ${name} before running this check`);
    return value;
}

function time(value, name) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error(`Set --${name} to an ISO 8601 timestamp with a time zone`);
    return parsed;
}

async function get(base, path, headers, query) {
    const url = new URL(path, base);
    url.search = new URLSearchParams(query).toString();
    const endpoint = `${url.origin}${url.pathname}`;
    const timeoutMs = 8000;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
        const response = await fetch(url, { headers, signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        const reason = signal.aborted ? `timed out after ${timeoutMs / 1000}s` : error.message;
        throw new Error(`${endpoint}: ${reason}`, { cause: error });
    }
}

async function compare(source, since, until) {
    const query = { since: new Date(since).toISOString(), limit: String(pageSize) };
    const result = await get(source.url, source.path, source.headers, query);
    if (result.data.length >= pageSize) {
        throw new Error(`${source.name} reached the upstream page limit. Use a shorter or more recent window.`);
    }
    const expected = new Set(result.data.filter((row) => {
        const at = Date.parse(row[source.timestamp]);
        return at >= since && at < until;
    }).map((row) => row[source.id]));

    const matches = new Map();
    const cursors = new Set();
    let cursor;
    do {
        const page = await get(required('AGGREGATOR_URL'), '/internal/audit/events', {
            Authorization: `Bearer ${required('BNPB_AUDIT_TOKEN')}`,
        }, { ...query, source: source.name, ...(cursor ? { cursor } : {}) });
        if (page.partial !== false) throw new Error(`Audit returned incomplete ${source.name} data`);
        for (const row of page.items) {
            if (expected.has(row.source_ref_id)) {
                matches.set(row.source_ref_id, (matches.get(row.source_ref_id) ?? 0) + 1);
            }
        }
        cursor = page.next_cursor;
        if (cursor && cursors.has(cursor)) throw new Error(`Audit repeated a cursor for ${source.name}`);
        if (cursor) cursors.add(cursor);
    } while (cursor);

    const missing = [...expected].filter((id) => !matches.has(id));
    const duplicates = [...matches].filter(([, count]) => count > 1).map(([id]) => id);
    return { source: source.name, expected: expected.size, found: matches.size, missing, duplicates };
}

async function main() {
    const { values } = parseArgs({ options: {
        since: { type: 'string' }, until: { type: 'string' },
        'fault-at': { type: 'string' }, 'takeover-at': { type: 'string' },
    } });
    const since = time(values.since, 'since');
    const until = time(values.until, 'until');
    if (until <= since) throw new Error('--until must be later than --since');

    let takeoverMs;
    if (values['fault-at'] || values['takeover-at']) {
        takeoverMs = time(values['takeover-at'], 'takeover-at') - time(values['fault-at'], 'fault-at');
        if (takeoverMs < 0) throw new Error('--takeover-at must be at or after --fault-at');
    }

    const sources = [
        { name: 'BMKG', url: required('BMKG_URL'), path: '/seismic-events', id: 'event_id', timestamp: 'occurred_at',
            headers: { 'X-BMKG-Key': required('BMKG_API_KEY') } },
        { name: 'PVMBG', url: required('PVMBG_URL'), path: '/volcanic-reports', id: 'report_id', timestamp: 'reported_at',
            headers: { Authorization: `Bearer ${required('PVMBG_TOKEN')}` } },
    ];
    const compared = await Promise.all(sources.map((source) => compare(source, since, until)));
    const failed = takeoverMs > 60_000 || compared.some(({ missing, duplicates }) => missing.length || duplicates.length);
    const status = failed ? 'failed' : compared.some(({ expected }) => expected === 0) ? 'inconclusive' : 'passed';
    console.log(JSON.stringify({ status, since: new Date(since), until: new Date(until),
        ...(takeoverMs !== undefined ? { takeoverMs } : {}), sources: compared }, null, 2));
    process.exitCode = failed ? 1 : status === 'inconclusive' ? 2 : 0;
}

main().catch((error) => {
    console.error(`Could not complete reconciliation: ${error.message}`);
    process.exitCode = 2;
});
