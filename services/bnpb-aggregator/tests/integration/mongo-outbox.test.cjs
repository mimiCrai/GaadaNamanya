require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CanonicalStore } = require('../../dist/src/db');
const { runMigrations, migrations } = require('../../dist/src/db/migration-runner');
const { HazardEventRepository } = require('../../dist/src/repositories/hazard-event.repository');
const { OutboxEventRepository } = require('../../dist/src/repositories/outbox-event.repository');
const { SourceSyncStateRepository } = require('../../dist/src/repositories/source-sync-state.repository');
const { PendingTsunamiWarningRepository } = require('../../dist/src/repositories/pending-tsunami-warning.repository');
const { OutboxRelayService } = require('../../dist/src/services/outbox-relay.service');

test('MongoDB canonical store and transactional outbox', { timeout: 120_000 }, async (t) => {
    const name = process.env.DATABASE_NAME;
    assert.match(name, /_integration$/, 'Use an isolated database ending in _integration');
    const store = new CanonicalStore(process.env.DATABASE_URL, name);
    await store.client.connect();
    const admin = store.client.db('admin');
    assert.equal((await admin.command({ hello: 1 })).msg, 'isdbgrid', 'Tests must run through mongos');
    await store.database.dropDatabase();
    try {
        assert.deepEqual(
            await runMigrations(store.database),
            migrations.map((migration) => migration.id)
        );
        await store.connect();
        const hazards = new HazardEventRepository(store);
        const outbox = new OutboxEventRepository(store);
        const states = new SourceSyncStateRepository(store);
        const pending = new PendingTsunamiWarningRepository(store);
        const hazardCollection = store.collection('hazard_events');
        const outboxCollection = store.collection('outbox_events');
        const input = {
            source: 'BMKG',
            sourceRefId: 'mongo-integration-seismic',
            hazardType: 'SEISMIC',
            severity: 'WASPADA',
            areaName: 'Integration Area',
            latitude: -6.2,
            longitude: 106.8,
            occurredAt: new Date('2026-01-01T00:00:00Z'),
            attributes: { magnitude: 5.1 },
            topic: 'hazard-events',
            correlationId: 'mongo-outbox-integration',
        };
        let original;

        await t.test('commits a hazard and its serialized outbox snapshot together', async () => {
            original = await hazards.upsertAndEnqueue(input);
            assert.equal(original.changeType, 'hazard.created');
            assert.equal(await hazardCollection.countDocuments(), 1);
            const events = await outbox.findUnpublished(100);
            assert.equal(events.length, 1);
            assert.equal(events[0].payload.hazard.hazardId, original.hazardEvent.hazardId);
            assert.equal(events[0].payload.hazard.occurredAt, input.occurredAt.toISOString());
            assert.equal(events[0].payload.eventId, events[0].outboxEventId);
            assert.equal('_id' in events[0].payload.hazard, false);
        });

        await t.test('overlapping identical polls do not create hazards or outbox duplicates', async () => {
            const results = await Promise.all(Array.from({ length: 8 }, () => hazards.upsertAndEnqueue(input)));
            assert.ok(results.every((result) => result.changeType === null));
            assert.equal(await hazardCollection.countDocuments(), 1);
            assert.equal(await outboxCollection.countDocuments(), 1);
        });

        await t.test('concurrent first inserts converge on one canonical identity', async () => {
            const next = { ...input, sourceRefId: 'concurrent-first-insert' };
            const results = await Promise.all(Array.from({ length: 8 }, () => hazards.upsertAndEnqueue(next)));
            assert.equal(new Set(results.map((result) => result.hazardEvent.hazardId)).size, 1);
            assert.equal(results.filter((result) => result.changeType === 'hazard.created').length, 1);
            assert.equal(await hazardCollection.countDocuments({ sourceRefId: next.sourceRefId }), 1);
        });

        await t.test('updates preserve hazard ID and enqueue an updated snapshot', async () => {
            const changed = await hazards.upsertAndEnqueue({
                ...input,
                severity: 'AWAS',
                attributes: { magnitude: 6.5 },
            });
            assert.equal(changed.hazardEvent.hazardId, original.hazardEvent.hazardId);
            assert.equal(changed.changeType, 'hazard.updated');
            const event = await outboxCollection.findOne({
                aggregateId: changed.hazardEvent.hazardId,
                eventType: 'hazard.updated',
            });
            assert.equal(event.payload.hazard.severity, 'AWAS');
        });

        await t.test('outbox insert failure rolls back both new hazard and existing hazard update', async () => {
            const count = await outboxCollection.countDocuments();
            await store.database.command({
                collMod: 'outbox_events',
                validator: { topic: { $ne: 'reject-transaction' } },
            });
            try {
                await assert.rejects(
                    hazards.upsertAndEnqueue({ ...input, sourceRefId: 'must-not-exist', topic: 'reject-transaction' })
                );
                await assert.rejects(
                    hazards.upsertAndEnqueue({ ...input, severity: 'NORMAL', topic: 'reject-transaction' })
                );
                assert.equal(await hazards.findBySourceAndRefId('BMKG', 'must-not-exist'), undefined);
                assert.equal((await hazards.findByHazardId(original.hazardEvent.hazardId)).severity, 'AWAS');
                assert.equal(await outboxCollection.countDocuments(), count);
            } finally {
                await store.database.command({ collMod: 'outbox_events', validator: {} });
            }
        });

        await t.test('source status survives errors, preserves staleSince, and recovers', async () => {
            const at = new Date('2026-01-02T00:00:00Z');
            assert.equal((await states.findAll()).length, 3);
            assert.equal((await states.recordFailedPoll('PVMBG_VOLCANIC', 'offline', at)).status, 'UNAVAILABLE');
            await states.recordSuccessfulPoll('PVMBG_VOLCANIC', at);
            const stale = await states.recordFailedPoll('PVMBG_VOLCANIC', '$timeout', at);
            const staleAgain = await states.recordFailedPoll(
                'PVMBG_VOLCANIC',
                'still offline',
                new Date(at.getTime() + 1000)
            );
            assert.equal(stale.status, 'STALE');
            assert.deepEqual(staleAgain.staleSince, stale.staleSince);
            assert.equal(staleAgain.consecutiveFailures, 2);
            assert.equal((await states.recordSuccessfulPoll('PVMBG_VOLCANIC', new Date())).staleSince, null);
        });

        await t.test('migration reruns and application reconnect preserve data, indexes, and checkpoints', async () => {
            const snapshot = async () =>
                (await states.findAll()).sort((a, b) => a.sourceStream.localeCompare(b.sourceStream));
            const before = await snapshot();
            const hazardCount = await hazardCollection.countDocuments();
            const outboxCount = await outboxCollection.countDocuments();
            const history = store.database.collection('schema_migrations');
            const applied = await history.find().sort({ _id: 1 }).toArray();
            assert.equal(applied.length, 2);
            assert.deepEqual(await runMigrations(store.database), []);
            await store.connect();
            assert.deepEqual(await history.find().sort({ _id: 1 }).toArray(), applied);
            assert.deepEqual(await snapshot(), before);
            assert.equal(await hazardCollection.countDocuments(), hazardCount);
            assert.equal(await outboxCollection.countDocuments(), outboxCount);
            assert.ok(
                (await outboxCollection.listIndexes().toArray()).some((index) => index.name === 'unpublished_in_order')
            );

            // Adopt a database created by the previous initializer without resetting its data.
            await history.deleteMany({});
            assert.equal((await runMigrations(store.database)).length, 2);
            assert.deepEqual(await snapshot(), before);
            assert.equal(await hazardCollection.countDocuments(), hazardCount);
            assert.equal(await outboxCollection.countDocuments(), outboxCount);
        });

        await t.test('failed migration is not recorded and succeeds when retried', async () => {
            const migration = {
                id: 'test-retry-migration',
                up: async () => {
                    throw new Error('migration interrupted');
                },
            };
            await assert.rejects(runMigrations(store.database, [migration]), /migration interrupted/);
            const history = store.database.collection('schema_migrations');
            assert.equal(await history.findOne({ _id: migration.id }), null);
            let calls = 0;
            migration.up = async () => {
                calls++;
            };
            assert.deepEqual(await runMigrations(store.database, [migration]), [migration.id]);
            assert.deepEqual(await runMigrations(store.database, [migration]), []);
            assert.equal(calls, 1);
        });

        await t.test('pending tsunami warnings upsert without losing first receipt time', async () => {
            const warning = { warning_id: 'pending-1', related_event_id: 'future-earthquake', warning_level: 'SIAGA' };
            await pending.save(warning);
            const [first] = await pending.findOldest(10);
            await pending.save({ ...warning, warning_level: 'AWAS' });
            const [updated] = await pending.findOldest(10);
            assert.deepEqual(updated.firstReceivedAt, first.firstReceivedAt);
            assert.equal(updated.warning.warning_level, 'AWAS');
            await pending.remove(warning.warning_id);
            assert.equal((await pending.findOldest(10)).length, 0);
        });

        await t.test('failed publish remains pending and the relay retries it', async () => {
            const events = await outbox.findUnpublished(100);
            const published = [];
            let fail = true;
            const relay = new OutboxRelayService(outbox, {
                publish: async (message) => {
                    if (fail) throw new Error('Kafka unavailable');
                    published.push(message.eventId);
                },
            });
            relay.start();
            try {
                await waitFor(
                    async () => (await outboxCollection.findOne({ _id: events[0].outboxEventId })).publishAttempts > 0
                );
                assert.equal((await outbox.findUnpublished(100)).length, events.length);
                fail = false;
                await waitFor(async () => (await outbox.findUnpublished(100)).length === 0);
                assert.deepEqual(new Set(published), new Set(events.map((event) => event.outboxEventId)));
            } finally {
                relay.stop();
            }
        });

        await t.test('data and pending outbox survive application reconnect; filters retain Date types', async () => {
            const saved = await hazards.upsertAndEnqueue({ ...input, sourceRefId: 'survive-reconnect' });
            const second = new CanonicalStore(process.env.DATABASE_URL, name);
            try {
                const repository = new HazardEventRepository(second);
                const result = await repository.findByHazardId(saved.hazardEvent.hazardId);
                assert.ok(result.occurredAt instanceof Date);
                assert.equal('_id' in result, false);
                const matching = await repository.findAll(saved.hazardEvent.ingestedAt, 'BMKG');
                assert.ok(matching.some((row) => row.hazardId === saved.hazardEvent.hazardId));
                assert.equal((await new OutboxEventRepository(second).findUnpublished(100)).length, 1);
            } finally {
                await second.close();
            }
        });

        await t.test('hazards physically occupy both shards', async () => {
            for (let index = 0; index < 24; index++) {
                await hazards.upsertAndEnqueue({ ...input, sourceRefId: `distribution-${index}` });
            }
            const stats = await hazardCollection.aggregate([{ $collStats: { count: {} } }]).toArray();
            assert.equal(new Set(stats.filter((row) => row.count > 0).map((row) => row.shard)).size, 2);
            assert.equal(
                stats.reduce((sum, row) => sum + row.count, 0),
                await hazardCollection.countDocuments()
            );
        });
    } finally {
        await store.database.dropDatabase();
        await store.close();
    }
});

async function waitFor(predicate) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for outbox relay');
}
