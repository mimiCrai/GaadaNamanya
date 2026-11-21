import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Measurement } from './measurement.mjs';
import { runMeasurement, validObservation } from './measure-e2e.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const observation = (id, critical = true) => ({
    observation_id: id,
    station_id: 'station',
    observed_at: '2026-11-12T00:00:00Z',
    sea_level_anomaly_m: 1,
    wave_height_m: 2,
    quality: 'ok',
    critical,
});
const audit = (id) => ({ source: 'SENSOR_PANTAI', source_ref_id: id, hazard_id: `hazard-${id}` });
const inbox = (id) => ({ eventId: `event-${id}`, hazardId: `hazard-${id}` });
function model() {
    const value = new Measurement();
    value.source([observation('historical')], { start: 0, end: 100 }, true);
    value.healthy = { sensor: true, audit: true, notification: true };
    return value;
}

test('excludes historical events and counts a repeated new ID once', () => {
    const m = model();
    const items = [observation('historical'), observation('new')];
    m.source(items, { start: 1000, end: 1100 });
    m.source(items, { start: 1500, end: 1600 });
    m.audit([audit('historical'), audit('new')]);
    m.notifications([inbox('historical'), inbox('new')], { start: 2000, end: 2100 });
    const result = m.report();
    assert.equal(result.historicalExcluded, 1);
    assert.equal(result.criticalExpected, 1);
    assert.equal(result.delivered, 1);
    assert.equal(result.status, 'pass');
});

test('a late observer cannot claim 200 ms when availability could have been over 5 seconds earlier', () => {
    const m = model();
    m.source([observation('historical'), observation('new')], { start: 5900, end: 6000 });
    m.audit([audit('new')]);
    m.notifications([inbox('new')], { start: 6100, end: 6200 });
    assert.deepEqual(m.report().p95Ms, { lower: 0, upper: 6200 });
    assert.equal(m.report().status, 'inconclusive');
    assert.equal(m.report().errorBudget.lateStatus, 'uncertain');
});

test('keeps receipt observed before the source scan, even if Audit mapping arrives later', () => {
    const m = model();
    m.notifications([inbox('new')], { start: 2000, end: 2100 });
    m.source([observation('historical'), observation('new')], { start: 3000, end: 3100 });
    m.audit([audit('new')]);
    assert.equal(m.report().samples[0].upperMs, 2100);
    assert.equal(m.report().status, 'pass');
});

test('a frozen source clock cannot move the availability bound forward', () => {
    const m = model();
    m.source([observation('historical')], { start: 1000, end: 1100, generatedAt: 100 });
    m.source([observation('historical')], { start: 9000, end: 9100, generatedAt: 100 });
    m.source([observation('historical'), observation('new')], { start: 10000, end: 10100, generatedAt: 100 });
    m.audit([audit('new')]);
    m.notifications([inbox('new')], { start: 10500, end: 10600 });
    assert.equal(m.report().p95Ms.upper, 9600);
    assert.equal(m.report().status, 'inconclusive');
});

test('reports a provable late delivery and an exceeded zero-event latency budget', () => {
    const m = model();
    m.source([observation('historical'), observation('new')], { start: 100, end: 200 });
    m.audit([audit('new')]);
    m.notifications([], { start: 6000, end: 6100 });
    m.notifications([inbox('new')], { start: 7000, end: 7100 });
    const report = m.report();
    assert.equal(report.status, 'fail');
    assert.equal(report.p95Ms.lower, 5800);
    assert.equal(report.errorBudget.lateAllowed, 0);
    assert.equal(report.errorBudget.lateDefinitely, 1);
    assert.equal(report.errorBudget.lateRemaining.maximum, -1);
    assert.equal(report.errorBudget.lateStatus, 'exceeded');
});

test('reports undelivered events instead of computing p95 only from the successful subset', () => {
    const m = model();
    m.source([observation('historical'), observation('new')], { start: 100, end: 200 });
    m.notifications([], { start: 6000, end: 6100 });
    const report = m.report();
    assert.equal(report.missingAfterDrain, 1);
    assert.equal(report.status, 'fail');
    assert.equal(report.p95Ms.upper, null);
});

test('does not pass with no new critical observations, an unavailable endpoint, or source history regression', () => {
    assert.equal(model().report().status, 'inconclusive');
    assert.equal(model().report().errorBudget.lateStatus, 'not_measured');
    const m = model();
    m.source([observation('historical'), observation('new')], { start: 100, end: 200 });
    m.failure('notification', 'HTTP 503');
    assert.equal(m.report().status, 'inconclusive');
    m.source([observation('new')], { start: 300, end: 400 });
    assert.ok(m.report().issues.includes('source_history_regressed'));
});

test('flags impossible timing instead of silently discarding a negative sample', () => {
    const m = model();
    m.notifications([inbox('new')], { start: 1000, end: 1100 });
    m.source([observation('historical')], { start: 2000, end: 2100 });
    m.source([observation('historical'), observation('new')], { start: 3000, end: 3100 });
    m.audit([audit('new')]);
    const report = m.report();
    assert.equal(report.invalidTimingSamples, 1);
    assert.equal(report.status, 'inconclusive');
    assert.ok(report.issues.includes('inconsistent_availability_interval'));
});

test('reports the 95% latency budget with 20 observations and one slow delivery', () => {
    const m = model();
    const points = Array.from({ length: 20 }, (_, i) => observation(String(i)));
    m.source([observation('historical'), ...points], { start: 100, end: 200 });
    m.audit(points.map((p) => audit(p.observation_id)));
    m.notifications(
        points.slice(0, 19).map((p) => inbox(p.observation_id)),
        { start: 1000, end: 1100 }
    );
    m.notifications(
        points.map((p) => inbox(p.observation_id)),
        { start: 7000, end: 7100 }
    );
    assert.equal(m.report().status, 'pass');
    assert.equal(m.report().errorBudget.lateAllowed, 1);
    assert.equal(m.report().errorBudget.latePossibly, 1);
    assert.equal(m.report().errorBudget.lateRemaining.minimum, 0);
});

for (const shift of [45000, -30000])
    test(`observer bounds survive wall-clock shift ${shift}`, () => {
        const original = Date.now;
        try {
            Date.now = () => original() + shift;
            const m = model();
            m.source([observation('historical'), observation('new')], { start: 100, end: 200 });
            m.audit([audit('new')]);
            m.notifications([inbox('new')], { start: 2000, end: 2100 });
            assert.equal(m.report().p95Ms.upper, 2100);
        } finally {
            Date.now = original;
        }
    });

const options = {
    sensorUrl: 'http://sensor',
    auditUrl: 'http://aggregator',
    notificationUrl: 'http://notification',
    sensorToken: 'source-secret',
    auditToken: 'audit-secret',
    durationMs: 150,
    drainMs: 100,
    intervalMs: 5,
    timeoutMs: 1000,
    maxPages: 4,
    maxRecordBytes: 8192,
    maxFutureMs: 30000,
};
function fixture(mode) {
    let sourceCalls = 0,
        inboxCalls = 0;
    return {
        fetchFn: async (url, request) => {
            if (url.hostname === 'sensor') assert.equal(request.headers.Authorization, 'Bearer source-secret');
            if (url.hostname === 'aggregator') assert.equal(request.headers.Authorization, 'Bearer audit-secret');
            let body;
            if (url.pathname === '/v1/stations')
                body = {
                    items: [{ station_id: 'station', name: 'Coast', province: 'Province', latitude: 1, longitude: 1 }],
                };
            else if (url.pathname === '/v1/observations')
                body = {
                    generated_at: '2026-11-12T00:01:00Z',
                    items:
                        ++sourceCalls <= 2
                            ? [observation('historical')]
                            : [observation('historical'), observation('new')],
                    next_cursor: mode === 'cycle' || mode === 'tail' ? 'same' : null,
                };
            else if (url.pathname === '/internal/audit/events')
                body = { items: [audit('new')], partial: mode === 'partial', next_cursor: null };
            else if (url.pathname === '/api/notifications') body = { data: ++inboxCalls > 1 ? [inbox('new')] : [] };
            else throw new Error('Unexpected endpoint');
            if (mode === 'cycle' && url.pathname === '/v1/observations')
                body.items = Array.from({ length: 1000 }, () => observation('historical'));
            return new Response(JSON.stringify(body));
        },
    };
}

test('automates source/audit/inbox correlation and measures only new critical IDs', async () => {
    const report = await runMeasurement(options, fixture());
    assert.equal(report.status, 'pass');
    assert.equal(report.historicalExcluded, 1);
    assert.equal(report.criticalExpected, 1);
    assert.equal(report.delivered, 1);
    assert.ok(report.requests.sensor > 0);
    assert.ok(!JSON.stringify(report).includes('secret'));
});

test('finishes a live source scan on a short page even when a resume cursor remains', async () => {
    const report = await runMeasurement(options, fixture('tail'));
    assert.equal(report.status, 'pass');
    assert.equal(report.criticalExpected, 1);
});

test('partial Audit responses cannot produce a passing measurement', async () => {
    const report = await runMeasurement(options, fixture('partial'));
    assert.equal(report.status, 'inconclusive');
    assert.ok(Object.keys(report.observerErrors).some((key) => key.includes('partial audit response')));
});

test('pagination cycles fail the baseline rather than silently truncating the expected input', async () => {
    await assert.rejects(runMeasurement(options, fixture('cycle')), /cursor cycle/);
});

test('excludes malformed critical observations according to the ingestion contract', () => {
    const stations = new Set(['station']);
    const item = observation('id');
    assert.equal(validObservation(item, '2026-11-12T00:00:00Z', stations), true);
    for (const patch of [
        { wave_height_m: -1 },
        { station_id: 'unknown' },
        { critical: 'true' },
        { observed_at: '2026-11-13T00:00:00Z' },
        { observed_at: '2026-02-30T00:00:00Z' },
        { observed_at: '2026-11-12T24:00:00Z' },
    ]) {
        assert.equal(validObservation({ ...item, ...patch }, '2026-11-12T00:00:00Z', stations), false);
    }
    assert.equal(
        validObservation({ ...item, observed_at: '2026-11-12T00:00+0000' }, '2026-11-12T00:00:00Z', stations),
        true
    );
});

function historyFixture({ size = 6000, backfill = false, slowVerification = false } = {}) {
    const history = Array.from({ length: size }, (_, i) => observation(`history-${String(i).padStart(6, '0')}`, false));
    let live = false,
        tailReads = 0;
    const trace = {
        fullStarts: 0,
        incrementalCursors: [],
        inboxReads: 0,
        firstReceiptAt: null,
        verificationPageAt: null,
    };
    return {
        trace,
        io: {
            fetchFn: async (url) => {
                let body;
                if (url.pathname === '/v1/stations')
                    body = {
                        items: [
                            { station_id: 'station', name: 'Coast', province: 'Province', latitude: 1, longitude: 1 },
                        ],
                    };
                else if (url.pathname === '/v1/observations') {
                    const cursor = url.searchParams.get('cursor');
                    const offset = cursor === null ? 0 : Number(cursor);
                    if (cursor === null) trace.fullStarts++;
                    if (offset >= size) {
                        trace.incrementalCursors.push(cursor);
                        if (++tailReads >= 3) live = true;
                    }
                    if (slowVerification && trace.fullStarts === 2 && offset < size) {
                        await delay(35);
                        trace.verificationPageAt = performance.now();
                    }
                    const rows = [...history, ...(live ? [observation('zz-critical')] : [])];
                    if (live && backfill)
                        rows.unshift({ ...observation('backfilled-critical'), observed_at: '2026-11-11T23:59:00Z' });
                    const items = rows.slice(offset, offset + 1000);
                    body = { generated_at: '2026-11-12T00:01:00Z', items, next_cursor: String(offset + items.length) };
                } else if (url.pathname === '/internal/audit/events') {
                    body = {
                        items: [audit('zz-critical'), ...(backfill ? [audit('backfilled-critical')] : [])],
                        partial: false,
                        next_cursor: null,
                    };
                } else if (url.pathname === '/api/notifications') {
                    trace.inboxReads++;
                    const received = live && (!slowVerification || trace.fullStarts >= 2);
                    if (received) trace.firstReceiptAt ??= performance.now();
                    body = { data: received ? [inbox('zz-critical')] : [] };
                } else throw new Error('Unexpected endpoint');
                return new Response(JSON.stringify(body));
            },
        },
    };
}

test('5,000 historical observations do not force an inconclusive result at the real 500 ms interval', async () => {
    const fixture = historyFixture({ size: 5000 });
    const report = await runMeasurement(
        { ...options, intervalMs: 500, durationMs: 750, drainMs: 500, maxPages: 10 },
        fixture.io
    );
    assert.equal(report.status, 'pass');
    assert.equal(report.historicalExcluded, 5000);
    assert.equal(report.delivered, 1);
    assert.ok(report.p95Ms.upper < 5000);
    assert.equal(fixture.trace.fullStarts, 2);
    assert.equal(report.sourceScans.full, 2);
    assert.ok(fixture.trace.incrementalCursors.every((cursor) => cursor === '5000'));
});

test('inbox sampling continues while the final full source verification is slow', async () => {
    const fixture = historyFixture({ slowVerification: true });
    const report = await runMeasurement({ ...options, maxPages: 10 }, fixture.io);
    assert.equal(report.status, 'pass');
    assert.ok(fixture.trace.firstReceiptAt < fixture.trace.verificationPageAt);
    assert.equal(fixture.trace.fullStarts, 2);
});

test('a backfilled critical event skipped by the cursor is discovered and cannot produce a false pass', async () => {
    const fixture = historyFixture({ backfill: true });
    const report = await runMeasurement({ ...options, maxPages: 10 }, fixture.io);
    assert.equal(report.criticalExpected, 2);
    assert.equal(report.delivered, 1);
    assert.equal(report.status, 'inconclusive');
    assert.ok(report.issues.includes('source_cursor_missed_event'));
});

test('does not query Audit or the inbox repeatedly when there are no new critical events', async () => {
    const io = fixture();
    const fetchFn = io.fetchFn;
    io.fetchFn = async (url, request) => {
        const response = await fetchFn(url, request);
        if (url.pathname !== '/v1/observations') return response;
        const body = await response.json();
        body.items = body.items.map((item) => ({ ...item, critical: false }));
        return new Response(JSON.stringify(body));
    };
    const report = await runMeasurement(options, io);
    assert.equal(report.status, 'inconclusive');
    assert.equal(report.criticalExpected, 0);
    assert.equal(report.requests.audit, 0);
    assert.equal(report.requests.notification, 0);
});
