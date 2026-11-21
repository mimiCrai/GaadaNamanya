// Integration (Tahap 4, D-37): replay = requeue for the Tahap 1 retry worker, with the PVMBG mapping active at
// processing time, against the real sharded store (through mongos).
// Run: DATABASE_URL=... DATABASE_NAME=canonical_store_integration npm run build && node --test tests/integration/dlq-replay.test.cjs
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { CanonicalStore } = require('../../dist/src/db');
const { runMigrations } = require('../../dist/src/db/migration-runner');
const { BackgroundLeaseRepository } = require('../../dist/src/repositories/background-lease.repository');
const { PayloadStore } = require('../../dist/src/repositories/payload-store.repository');
const { UnprocessedMessageRepository } = require('../../dist/src/repositories/unprocessed-message.repository');
const { HazardEventRepository } = require('../../dist/src/repositories/hazard-event.repository');
const { HazardEventIngestionService } = require('../../dist/src/services/hazard-event-ingestion.service');
const { OrderingSequenceRepository } = require('../../dist/src/repositories/ordering-sequence.repository');
const { UnprocessedRecorder } = require('../../dist/src/services/unprocessed-recorder.service');
const { UnprocessedHandlerRegistry } = require('../../dist/src/services/unprocessed-handler.registry');
const { UnprocessedRetryService } = require('../../dist/src/services/unprocessed-retry.service');
const { UnprocessedReplayService } = require('../../dist/src/services/unprocessed-replay.service');
const { BUILTIN_MAPPING, parseMappingFile } = require('../../dist/src/libs/pvmbg-mapping');
const { ProcessingError } = require('../../dist/src/libs/processing-error');

const ADJUSTED = parseMappingFile(readFileSync(path.join(__dirname, '../../config/pvmbg-mapping/examples/m2-adjusted.json')));
const base = (id, at, extra) => ({
    report_id: id,
    volcano_id: 'MERAPI',
    eruption_count_24h: 3,
    ash_column_height_m: 1200.5,
    reported_at: at,
    confidence_level: 0.9,
    ...extra,
});

test('DLQ replay after a schema adjustment (P3 #4)', { timeout: 180_000 }, async (t) => {
    const name = process.env.DATABASE_NAME;
    assert.match(name, /_integration$/, 'Use an isolated database ending in _integration');
    const store = new CanonicalStore(process.env.DATABASE_URL, name.replace(/_integration$/, '_replay_integration'));
    await store.client.connect();
    await store.database.dropDatabase();
    let leaseTimer;
    try {
        await runMigrations(store.database);
        const leases = new BackgroundLeaseRepository(store);
        const grant = await leases.acquireOrRenew('replay-integration');
        const lease = { ownerId: grant.ownerId, epoch: grant.epoch };
        leaseTimer = setInterval(() => void leases.acquireOrRenew(lease.ownerId).catch(() => undefined), 2000);

        let mapping = BUILTIN_MAPPING;
        const dlq = new UnprocessedMessageRepository(store, leases, new PayloadStore(store));
        const hazards = new HazardEventRepository(store, leases);
        const recorder = new UnprocessedRecorder(dlq);
        const ingestion = new HazardEventIngestionService(hazards, {}, recorder, new OrderingSequenceRepository(store), {
            active: () => mapping,
        });
        const registry = new UnprocessedHandlerRegistry(ingestion);
        const worker = new UnprocessedRetryService(dlq, registry, { current: () => lease, invalidate: () => undefined });
        const replays = new UnprocessedReplayService(dlq, registry);

        const messages = store.database.collection('unprocessed_messages');
        const outbox = store.database.collection('outbox_events');
        const hazardOf = (id) => hazards.findBySourceAndRefId('PVMBG', id);
        const outboxCount = () => outbox.countDocuments({});
        const hazardCount = () => store.database.collection('hazard_events').countDocuments({ source: 'PVMBG' });
        const open = (source) => messages.countDocuments({ source, status: { $in: ['retrying', 'parked'] } });
        async function drain() {
            await new Promise((resolve) => setTimeout(resolve, 50));
            for (let i = 0; i < 10 && (await messages.countDocuments({ status: 'retrying' })) > 0; i++) {
                await worker.runOnce();
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        }

        // Before the adjustment: rename / type change / missing field are parked; one newer report is stored normally.
        await ingestion.ingestVolcanicReports([base('rp-1', '2026-11-20T10:00:00Z', { level: 'Normal' })], 'poll-1', lease);
        await ingestion.ingestVolcanicReports([base('rp-2', '2026-11-20T10:01:00Z', { alert_level: 2 })], 'poll-2', lease);
        await ingestion.ingestVolcanicReports([base('rp-1', '2026-11-20T10:02:00Z', { level: 'Awas' })], 'poll-3', lease);
        await ingestion.ingestVolcanicReports([base('rp-3', '2026-11-20T10:05:00Z', { alert_level: 'Siaga' })], 'poll-4', lease);
        await ingestion.ingestVolcanicReports([base('rp-3', '2026-11-20T10:03:00Z', { level: 'Waspada' })], 'poll-5', lease);
        const missing = base('rp-4', '2026-11-20T10:04:00Z', { alert_level: 'Waspada' });
        delete missing.eruption_count_24h;
        await ingestion.ingestVolcanicReports([missing], 'poll-6', lease);
        await ingestion.ingestVolcanicReports([base('rp-5', '2026-11-20T10:06:00Z', { alert_level: 'Siaga', volcano_id: 'GUNUNG_X' })], 'poll-7', lease);
        await recorder.record(
            {
                source: 'SATELIT',
                context: { kind: 'stream.event', endpoint: 'GET /v1/stream', topic: null },
                payload: { kind: 'inline', bytes: Buffer.from('id: 133\ndata: {"offset":133,"det') },
                contentType: 'text/event-stream',
                correlationId: 'sat',
                sourceRefId: 'offset:133',
                error: new ProcessingError('malformed_json', 'JSON terpotong'),
            },
            lease
        );
        assert.equal(await open('PVMBG'), 6);
        assert.equal(await hazardCount(), 1, 'only rp-3 10:05 was stored');

        await t.test('first replay requeues PVMBG, skips SATELIT (no handler), recovers with the new mapping', async () => {
            mapping = ADJUSTED;
            const result = await replays.replay({ status: 'parked' }, 'replay-1');
            assert.equal(result.requeued, 6);
            assert.deepEqual(result.skipped.map((s) => [s.reason, s.count]), [['handler_missing', 1]]);
            await drain();

            const rp1 = await hazardOf('rp-1');
            assert.equal(rp1.severity, 'AWAS', 'newest report of rp-1 wins');
            assert.equal(rp1.occurredAt.toISOString(), '2026-11-20T10:02:00.000Z');
            assert.equal((await hazardOf('rp-2')).severity, 'SIAGA', '2 → Siaga via the coercion table');
            assert.equal((await hazardOf('rp-3')).severity, 'SIAGA', 'older rp-3 (10:03) did not overwrite 10:05');
            assert.equal((await hazardOf('rp-4')).attributes.eruption_count_24h, undefined);
            const rp3Entry = await messages.findOne({ sourceRefId: 'rp-3' });
            assert.equal(rp3Entry.status, 'superseded');
            const bad = await messages.findOne({ sourceRefId: 'rp-5' });
            assert.equal(bad.status, 'parked', 'still failing → parked again');
            assert.equal(bad.reason, "validation_failed: volcano_id 'GUNUNG_X' tidak ada di tabel referensi BNPB");
            assert.ok(bad.history.some((h) => h.reason.startsWith('requeued: replay manual')));
            assert.equal(await open('PVMBG'), 1, 'audit shows only the entry that is still failing');
            assert.equal(await open('SATELIT'), 1);
        });

        await t.test('second replay creates no HazardEvent or outbox duplicates', async () => {
            const hazardsBefore = await hazardCount();
            const outboxBefore = await outboxCount();
            const result = await replays.replay({ status: 'parked', source: 'PVMBG' }, 'replay-2');
            assert.equal(result.requeued, 1, 'only rp-5 is parked');
            await drain();
            // the live poll overlap re-delivers the same bytes: still no change
            await ingestion.ingestVolcanicReports([base('rp-1', '2026-11-20T10:02:00Z', { level: 'Awas' })], 'poll-8', lease);
            assert.equal(await hazardCount(), hazardsBefore);
            assert.equal(await outboxCount(), outboxBefore);
            assert.equal(await messages.countDocuments({ status: 'recovered' }), 4);
        });
    } finally {
        clearInterval(leaseTimer);
        await store.database.dropDatabase().catch(() => undefined);
        await store.client.close();
    }
});
