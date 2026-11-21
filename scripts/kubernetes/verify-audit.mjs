#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const base = process.env.AGGREGATOR_URL;
const token = process.env.BNPB_AUDIT_TOKEN;
assert.ok(base && token, 'Set AGGREGATOR_URL and BNPB_AUDIT_TOKEN; freeze input updates during this verification');
const source = process.env.AUDIT_SOURCE;
const params = new URLSearchParams(source ? { source } : {});
async function get(path, query, authorized = true) {
    const response = await fetch(`${base.replace(/\/$/, '')}${path}?${query}`, {
        headers: authorized ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
}
const unauthorized = await get('/internal/audit/events', '', false);
assert.equal(unauthorized.status, 401);
assert.equal(unauthorized.body.error.code, 'unauthorized');
assert.equal((await get('/internal/audit/events', 'limit=1001')).status, 400);
const items = [], ids = new Set(), cursors = new Set();
let cursor;
do {
    const query = new URLSearchParams(params);
    query.set('limit', process.env.PAGE_SIZE ?? '50');
    if (cursor) query.set('cursor', cursor);
    const page = await get('/internal/audit/events', query);
    assert.equal(page.status, 200);
    assert.equal(page.body.partial, false, 'Wait for recovery before comparing a complete catalog');
    assert.deepEqual(page.body.unavailable_units, []);
    for (const item of page.body.items) {
        assert.ok(!ids.has(item.hazard_id), `Duplicate event across pages: ${item.hazard_id}`);
        const previous = items.at(-1);
        if (previous) assert.ok(item.ingested_at > previous.ingested_at ||
            (item.ingested_at === previous.ingested_at && Buffer.compare(Buffer.from(item.hazard_id), Buffer.from(previous.hazard_id)) > 0));
        ids.add(item.hazard_id);
        items.push(item);
    }
    cursor = page.body.next_cursor;
    assert.ok(cursor === null || (typeof cursor === 'string' && !cursors.has(cursor)), 'Cursor must advance and end with null');
    if (cursor) cursors.add(cursor);
} while (cursor);
assert.ok(items.length > 0, 'Import a nonempty fixture/catalog first');
const refs = items.map(x => x.source_ref_id).sort((a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
const checksum = await get('/internal/audit/checksum', params);
assert.equal(checksum.status, 200);
assert.equal(checksum.body.partial, false);
assert.equal(checksum.body.count, items.length);
assert.equal(checksum.body.checksum, createHash('sha256').update(refs.join('\n')).digest('hex'));
const query = new URLSearchParams(params); query.set('since', items[0].ingested_at); query.set('limit', '1000');
const since = await get('/internal/audit/events', query);
assert.ok(since.body.items.some(x => x.hazard_id === items[0].hazard_id), 'since must be inclusive');
let nodeNames;
if (process.env.KUBE_CONTEXT) {
    nodeNames = new Set(JSON.parse(execFileSync('kubectl', ['--context', process.env.KUBE_CONTEXT, 'get', 'nodes', '-o', 'json'], { encoding: 'utf8' })).items.map(x => x.metadata.name));
}
for (const item of items.slice(0, 10)) {
    const location = await get('/internal/audit/location', new URLSearchParams({ hazard_id: item.hazard_id }));
    assert.equal(location.status, 200);
    assert.equal(location.body.partial, false);
    assert.equal(location.body.locations.length, 3);
    assert.equal(location.body.locations.filter(x => x.role === 'primary').length, 1);
    for (const entry of location.body.locations) {
        assert.ok(entry.unit && ['primary', 'replica'].includes(entry.role));
        if (nodeNames) assert.ok(nodeNames.has(entry.node), `Location must use actual Kubernetes node: ${entry.node}`);
    }
}
const missing = await get('/internal/audit/location', 'hazard_id=absent-test-event');
assert.equal(missing.status, 404);
console.log(JSON.stringify({ as_of: new Date().toISOString(), source: source ?? null,
    count: items.length, checksum: checksum.body.checksum, pages: cursors.size + 1, status: 'passed' }, null, 2));
