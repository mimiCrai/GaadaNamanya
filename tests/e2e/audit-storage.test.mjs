import assert from 'node:assert/strict';
import { test } from 'node:test';

const base = process.env.AGGREGATOR_URL;
const headers = { Authorization: `Bearer ${process.env.BNPB_AUDIT_TOKEN}` };
const stage = process.env.STORAGE_TEST_STAGE ?? 'normal';

async function get(path, auth = headers) {
    const start = Date.now();
    const response = await fetch(`${base}${path}`, { headers: auth, signal: AbortSignal.timeout(8000) });
    return { status: response.status, body: await response.json(), elapsed: Date.now() - start };
}

test(`Audit API / storage reads: ${stage}`, { timeout: 120_000 }, async () => {
    if (stage === 'normal') {
        const denied = await get('/internal/audit/events', { 'X-BNPB-Internal-Key': process.env.BNPB_INTERNAL_API_KEY });
        assert.equal(denied.status, 401);
        assert.equal(denied.body.error.code, 'unauthorized');
        const invalid = await get('/internal/audit/events?limit=1001');
        assert.equal(invalid.status, 400);
        assert.equal(invalid.body.error.code, 'bad_request');
        const page = await get('/internal/audit/events?limit=2');
        assert.equal(page.status, 200);
        assert.equal(page.body.partial, false);
        assert.equal(page.body.items.length, 2);
        assert.ok(page.body.next_cursor);
        assert.ok(page.body.items[0].source_ref_id);
        assert.equal('sourceRefId' in page.body.items[0], false);
        const next = await get(`/internal/audit/events?limit=2&cursor=${encodeURIComponent(page.body.next_cursor)}`);
        assert.equal(next.status, 200);
        assert.ok(next.body.items.every((row) => row.hazard_id !== page.body.items[0].hazard_id));
        const tampered = await get(`/internal/audit/events?cursor=${encodeURIComponent(page.body.next_cursor)}x`);
        assert.equal(tampered.status, 400);
        assert.equal(tampered.body.error.code, 'bad_request');
        const checksum = await get('/internal/audit/checksum?source=BMKG');
        assert.equal(checksum.body.partial, false);
        assert.match(checksum.body.checksum, /^[0-9a-f]{64}$/);
        const location = await get(`/internal/audit/location?hazard_id=${page.body.items[0].hazard_id}`);
        assert.equal(location.status, 200);
        assert.equal(location.body.partial, false);
        assert.equal(location.body.locations.length, 3);
        assert.equal(location.body.locations.filter((row) => row.role === 'primary').length, 1);
        const missing = await get('/internal/audit/location?hazard_id=absent');
        assert.equal(missing.status, 404);
        const hazards = await get('/internal/hazards?limit=2', { 'X-BNPB-Internal-Key': process.env.BNPB_INTERNAL_API_KEY });
        assert.equal(hazards.body.data.length, 2);
        assert.ok(hazards.body.meta.nextCursor);
        return;
    }

    const deadline = Date.now() + 90_000;
    let last;
    while (Date.now() < deadline) {
        last = await get('/internal/audit/events?limit=20');
        assert.equal(last.status, 200);
        assert.ok(last.elapsed < 7500, 'Storage reads must be bounded');
        if (stage === 'outage' && last.body.partial && last.body.items.length > 0) break;
        if (stage === 'recovery' && !last.body.partial && last.body.items.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (stage === 'outage') {
        assert.equal(last.body.partial, true);
        assert.ok(last.body.unavailable_units.includes('canonical-shard-b'));
        assert.ok(last.body.items.length > 0, 'Healthy shard data must still be returned');
        const checksum = await get('/internal/audit/checksum');
        assert.equal(checksum.status, 200);
        assert.equal(checksum.body.partial, true);
        const missing = await get('/internal/audit/location?hazard_id=absent');
        assert.equal(missing.status, 200, 'Incomplete lookup must not claim absence');
        assert.equal(missing.body.partial, true);
        const hazards = await get('/internal/hazards?limit=10', { 'X-BNPB-Internal-Key': process.env.BNPB_INTERNAL_API_KEY });
        assert.equal(hazards.status, 200);
        assert.equal(hazards.body.meta.partial, true);
    } else {
        assert.equal(last.body.partial, false);
        assert.deepEqual(last.body.unavailable_units, []);
        assert.ok(last.body.items.length > 0);
    }
});
