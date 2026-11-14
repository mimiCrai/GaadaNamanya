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
const { StorageTopologyService } = require('../../dist/src/services/storage-topology.service');
const { CanonicalReadRepository } = require('../../dist/src/repositories/canonical-read.repository');
const { CanonicalQueryService } = require('../../dist/src/services/canonical-query.service');
const { createHash } = require('node:crypto');
const { BackgroundLeaseRepository } = require('../../dist/src/repositories/background-lease.repository');

test('MongoDB canonical store and transactional outbox', { timeout: 120_000 }, async (t) => {
    const name = process.env.DATABASE_NAME;
    assert.match(name, /_integration$/, 'Use an isolated database ending in _integration');
    const store = new CanonicalStore(process.env.DATABASE_URL, name);
    await store.client.connect();
    const admin = store.client.db('admin');
    assert.equal((await admin.command({ hello: 1 })).msg, 'isdbgrid', 'Tests must run through mongos');
    await store.database.dropDatabase();
    let leaseTimer;
    try {
        assert.deepEqual(
            await runMigrations(store.database),
            migrations.map((migration) => migration.id)
        );
        await store.connect();
        const leases = new BackgroundLeaseRepository(store);
        const grant = await leases.acquireOrRenew('mongo-integration');
        const lease = { ownerId: grant.ownerId, epoch: grant.epoch };
        leaseTimer = setInterval(() => { void leases.acquireOrRenew(lease.ownerId).catch(() => undefined); }, 2000);
        const hazards = new HazardEventRepository(store, leases);
        const outbox = new OutboxEventRepository(store, leases);
        const states = new SourceSyncStateRepository(store, leases);
        const pending = new PendingTsunamiWarningRepository(store, leases);
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
            lease,
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
            assert.equal((await states.recordFailedPoll('PVMBG_VOLCANIC', 'offline', at, lease)).status, 'UNAVAILABLE');
            await states.recordSuccessfulPoll('PVMBG_VOLCANIC', at, lease);
            const stale = await states.recordFailedPoll('PVMBG_VOLCANIC', '$timeout', at, lease);
            const staleAgain = await states.recordFailedPoll(
                'PVMBG_VOLCANIC',
                'still offline',
                new Date(at.getTime() + 1000), lease
            );
            assert.equal(stale.status, 'STALE');
            assert.deepEqual(staleAgain.staleSince, stale.staleSince);
            assert.equal(staleAgain.consecutiveFailures, 2);
            assert.equal((await states.recordSuccessfulPoll('PVMBG_VOLCANIC', new Date(), lease)).staleSince, null);
        });

        await t.test('migration reruns and application reconnect preserve data, indexes, and checkpoints', async () => {
            const snapshot = async () =>
                (await states.findAll()).sort((a, b) => a.sourceStream.localeCompare(b.sourceStream));
            const before = await snapshot();
            const hazardCount = await hazardCollection.countDocuments();
            const outboxCount = await outboxCollection.countDocuments();
            const history = store.database.collection('schema_migrations');
            const applied = await history.find().sort({ _id: 1 }).toArray();
            assert.equal(applied.length, migrations.length);
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
            assert.equal((await runMigrations(store.database)).length, migrations.length);
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
            await pending.save(warning, lease);
            const [first] = await pending.findOldest(10);
            await pending.save({ ...warning, warning_level: 'AWAS' }, lease);
            const [updated] = await pending.findOldest(10);
            assert.deepEqual(updated.firstReceivedAt, first.firstReceivedAt);
            assert.equal(updated.warning.warning_level, 'AWAS');
            await pending.remove(warning.warning_id, lease);
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
            }, { current: () => lease, invalidate: () => undefined }, leases);
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
                const secondLeases = new BackgroundLeaseRepository(second);
                const repository = new HazardEventRepository(second, secondLeases);
                const result = await repository.findByHazardId(saved.hazardEvent.hazardId);
                assert.ok(result.occurredAt instanceof Date);
                assert.equal('_id' in result, false);
                const matching = await repository.findAll(saved.hazardEvent.ingestedAt, 'BMKG');
                assert.ok(matching.some((row) => row.hazardId === saved.hazardEvent.hazardId));
                assert.equal((await new OutboxEventRepository(second, secondLeases).findUnpublished(100)).length, 1);
            } finally {
                await second.close();
            }
        });

        await t.test('audit pagination, byte-ordered streaming checksum, and real replica locations', async () => {
            const topology = new StorageTopologyService(store);
            const reader = new CanonicalReadRepository(store, topology);
            const audit = new CanonicalQueryService(reader, topology);
            try {
                const fixtures = Array.from({ length: 1005 }, (_, index) => ({
                    _id: `audit-${String(index).padStart(4, '0')}`,
                    hazardId: `audit-${String(index).padStart(4, '0')}`,
                    source: 'SATELIT',
                    sourceRefId: index === 0 ? 'é' : index === 1 ? 'Z' : `ref-${index}`,
                    hazardType: 'WILDFIRE',
                    severity: 'WASPADA',
                    areaName: 'Audit Test',
                    latitude: 0,
                    longitude: 0,
                    occurredAt: new Date('2026-01-01T00:00:00Z'),
                    ingestedAt: new Date('2026-01-02T00:00:00Z'),
                    attributes: { detection_keys: ['N20|2026-01-01|243|-2.51230|113.80440'] },
                }));
                await hazardCollection.insertMany(fixtures);
                const seen = [];
                let cursor;
                do {
                    const page = await audit.events({ source: 'SATELIT', limit: 200, cursor });
                    assert.equal(page.partial, false);
                    assert.ok(page.items.length <= 200);
                    seen.push(...page.items.map((row) => row.hazard_id));
                    cursor = page.next_cursor;
                } while (cursor);
                assert.deepEqual(
                    seen,
                    fixtures.map((row) => row.hazardId)
                );
                assert.equal(new Set(seen).size, fixtures.length);
                const checksum = await audit.checksum('SATELIT');
                const refs = fixtures
                    .map((row) => row.sourceRefId)
                    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
                assert.equal(checksum.count, fixtures.length);
                assert.equal(checksum.partial, false);
                assert.equal(checksum.checksum, createHash('sha256').update(refs.join('\n')).digest('hex'));
                const empty = await audit.checksum('SENSOR_PANTAI');
                assert.equal(empty.count, 0);
                assert.equal(empty.checksum, createHash('sha256').update('').digest('hex'));
                const first = await audit.events({ source: 'SATELIT', limit: 1 });
                await assert.rejects(audit.events({ source: 'BMKG', cursor: first.next_cursor }), /does not match/);
                await assert.rejects(
                    audit.events({ source: 'SATELIT', cursor: `${first.next_cursor}x` }),
                    /Invalid cursor/
                );
                const filtered = await audit.events({ source: 'SATELIT', since: '2026-01-03T00:00:00Z' });
                assert.equal(filtered.items.length, 0);
                const location = await audit.location(fixtures[0].hazardId);
                assert.equal(location.partial, false);
                assert.equal(location.locations.length, 3);
                assert.equal(location.locations.filter((row) => row.role === 'primary').length, 1);
                assert.equal(await audit.location('does-not-exist'), null);
                const latest = await audit.hazards({ source: 'SATELIT', limit: 50 });
                assert.equal(latest.data.length, 50);
                assert.ok(latest.meta.nextCursor);
                const second = await audit.hazards({ source: 'SATELIT', limit: 50, cursor: latest.meta.nextCursor });
                assert.equal(second.data[0].hazardId, fixtures[50].hazardId);
            } finally {
                await topology.close();
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
        clearInterval(leaseTimer);
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
