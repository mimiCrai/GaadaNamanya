// Integration (Tahap 4, D-39): idempotent field report insert on the sharded store, without the background lease.
// Run: DATABASE_URL=... DATABASE_NAME=canonical_store_integration npm run build && node --test tests/integration/field-reports.test.cjs
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { CanonicalStore } = require('../../dist/src/db');
const { runMigrations } = require('../../dist/src/db/migration-runner');
const { FieldReportRepository } = require('../../dist/src/repositories/field-report.repository');
const { BackgroundLeaseRepository } = require('../../dist/src/repositories/background-lease.repository');
const { PayloadStore } = require('../../dist/src/repositories/payload-store.repository');
const { UnprocessedMessageRepository } = require('../../dist/src/repositories/unprocessed-message.repository');
const { UnprocessedHandlerRegistry } = require('../../dist/src/services/unprocessed-handler.registry');
const { UnprocessedRetryService } = require('../../dist/src/services/unprocessed-retry.service');
const { UnprocessedRecorder } = require('../../dist/src/services/unprocessed-recorder.service');
const { ProcessingError } = require('../../dist/src/libs/processing-error');

const message = (id, description = 'Awan panas guguran') => ({
    v: 1,
    report: {
        report_id: id,
        hazard_type: 'VOLCANIC',
        latitude: -7.5407,
        longitude: 110.4457,
        description,
        severity_estimate: 'SIAGA',
        reported_at: '2026-11-20T10:00:00+07:00',
    },
    reporter: { sub: 'user-lapangan', role: 'lapangan' },
    accepted_at: new Date().toISOString(),
});

test('field_reports on the sharded canonical store (D-39)', { timeout: 120_000 }, async (t) => {
    const name = process.env.DATABASE_NAME;
    assert.match(name, /_integration$/);
    const store = new CanonicalStore(process.env.DATABASE_URL, name.replace(/_integration$/, '_field_reports_integration'));
    await store.client.connect();
    await store.database.dropDatabase();
    try {
        await runMigrations(store.database);
        const reports = new FieldReportRepository(store);
        const collection = store.database.collection('field_reports');

        await t.test('collection is sharded on hashed _id', async () => {
            const meta = await store.client
                .db('config')
                .collection('collections')
                .findOne({ _id: `${store.database.databaseName}.field_reports` });
            assert.deepEqual(meta.key, { _id: 'hashed' });
        });

        await t.test('20 concurrent deliveries of one report from different "replicas" → one document', async () => {
            const id = randomUUID();
            const msg = message(id);
            const results = await Promise.all(
                Array.from({ length: 20 }, (_, i) => reports.insertOnce(msg, { topic: 'field-reports', partition: 0, offset: String(i) }, `c${i}`))
            );
            assert.equal(results.filter((r) => r.result === 'created').length, 1);
            assert.equal(results.filter((r) => r.result === 'duplicate').length, 19);
            assert.equal(await collection.countDocuments({ _id: id }), 1);
            assert.equal((await reports.findById(id)).deliveries, 20);
        });

        await t.test('a resend with a new accepted_at is a duplicate; different content is a conflict that changes nothing', async () => {
            const id = randomUUID();
            const first = await reports.insertOnce(message(id), null, 'c1');
            const resend = await reports.insertOnce({ ...message(id), accepted_at: '2030-01-01T00:00:00.000Z' }, null, 'c2');
            const other = await reports.insertOnce(message(id, 'isi lain'), null, 'c3');
            assert.deepEqual([first.result, resend.result, other.result], ['created', 'duplicate', 'conflict']);
            const stored = await reports.findById(id);
            assert.equal(stored.description, 'Awan panas guguran');
            assert.equal(stored.acceptedAt.toISOString(), first.report.acceptedAt.toISOString(), 'first accepted_at kept');
            assert.notEqual(other.incomingSha256, stored.contentSha256);
        });

        await t.test('replay handler FIELD_REPORT:kafka.field-report stores a parked report once', async () => {
            const leases = new BackgroundLeaseRepository(store);
            const grant = await leases.acquireOrRenew('field-report-integration');
            const lease = { ownerId: grant.ownerId, epoch: grant.epoch };
            const dlq = new UnprocessedMessageRepository(store, leases, new PayloadStore(store));
            const registry = new UnprocessedHandlerRegistry({}, reports);
            const worker = new UnprocessedRetryService(dlq, registry, { current: () => lease, invalidate: () => undefined });
            const id = randomUUID();
            await new UnprocessedRecorder(dlq).record({
                source: 'FIELD_REPORT',
                context: { kind: 'kafka.field-report', endpoint: null, topic: 'field-reports' },
                payload: { kind: 'inline', bytes: Buffer.from(JSON.stringify(message(id))) },
                contentType: 'application/json',
                correlationId: 'c',
                sourceRefId: id,
                error: new ProcessingError('store_unavailable', 'aggregator mati'),
            });
            await store.database.collection('unprocessed_messages').updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
            await worker.runOnce();
            assert.equal(await collection.countDocuments({ _id: id }), 1);
            assert.equal((await store.database.collection('unprocessed_messages').findOne({ sourceRefId: id })).status, 'recovered');
        });
    } finally {
        await store.database.dropDatabase().catch(() => undefined);
        await store.client.close();
    }
});
