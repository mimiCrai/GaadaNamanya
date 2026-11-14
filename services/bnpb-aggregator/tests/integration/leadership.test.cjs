require('reflect-metadata');
process.env.BACKGROUND_LEASE_MS = '5000';
process.env.BACKGROUND_LEASE_RENEW_MS = '500';
process.env.LEASE_OPERATION_TIMEOUT_MS = '1000';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { CanonicalStore } = require('../../dist/src/db');
const { runMigrations } = require('../../dist/src/db/migration-runner');
const { BackgroundLeaseRepository } = require('../../dist/src/repositories/background-lease.repository');
const { HazardEventRepository } = require('../../dist/src/repositories/hazard-event.repository');
const { SourceSyncStateRepository } = require('../../dist/src/repositories/source-sync-state.repository');
const { PendingTsunamiWarningRepository } = require('../../dist/src/repositories/pending-tsunami-warning.repository');
const { OutboxEventRepository } = require('../../dist/src/repositories/outbox-event.repository');
const { LeaseLostError, backgroundLeaseId } = require('../../dist/src/db/schema/background-leases');

test('MongoDB lease election and transactional fencing', { timeout: 120_000 }, async (t) => {
    assert.match(process.env.DATABASE_NAME, /_integration$/);
    const name = process.env.DATABASE_NAME.replace(/_integration$/, '_leadership_integration');
    const stores = Array.from({ length: 3 }, () => new CanonicalStore(process.env.DATABASE_URL, name));
    await Promise.all(stores.map((store) => store.connect()));
    const db = stores[0].database;
    try {
        await db.dropDatabase();
        await runMigrations(db);
        await db.createCollection('fence_probes');
        const repos = stores.map((store) => new BackgroundLeaseRepository(store));
        const hazards = new HazardEventRepository(stores[0], repos[0]);
        const states = new SourceSyncStateRepository(stores[0], repos[0]);
        const pending = new PendingTsunamiWarningRepository(stores[0], repos[0]);
        const outbox = new OutboxEventRepository(stores[0], repos[0]);
        const leaseDoc = db.collection('background_leases');
        const expire = () => leaseDoc.updateOne({ _id: backgroundLeaseId }, { $set: { expiresAt: new Date(0) } });
        let owner;
        let token;
        let input;

        await t.test('three contenders receive exactly one grant; renewal preserves its epoch', async () => {
            const grants = await Promise.all(repos.map((repo, index) => repo.acquireOrRenew(`instance-${index}`)));
            assert.equal(grants.filter(Boolean).length, 1);
            owner = grants.findIndex(Boolean);
            token = { ownerId: grants[owner].ownerId, epoch: grants[owner].epoch };
            const renewed = await repos[owner].acquireOrRenew(token.ownerId);
            assert.equal(renewed.epoch, token.epoch);
            assert.equal(renewed.expiresAt.getTime() - renewed.checkedAt.getTime(), 5000);
        });

        await t.test('application clock shifts of +45s and -30s do not transfer ownership', async () => {
            const systemNow = Date.now;
            try {
                for (const offset of [45_000, -30_000]) {
                    Date.now = () => systemNow() + offset;
                    const renewed = await repos[owner].acquireOrRenew(token.ownerId);
                    assert.equal(renewed.epoch, token.epoch);
                    assert.equal(await repos[(owner + 1) % 3].acquireOrRenew('clock-contender'), null);
                    const time = await repos[owner].requireActive(token);
                    assert.ok(Math.abs(time.getTime() - systemNow()) < 2000);
                }
            } finally {
                Date.now = systemNow;
            }
        });

        await t.test(
            'takeover fences every old write, including identical hazards and checkpoint/outbox changes',
            async () => {
                await repos[owner].acquireOrRenew(token.ownerId);
                input = {
                    source: 'BMKG',
                    sourceRefId: 'fence-test',
                    hazardType: 'SEISMIC',
                    severity: 'NORMAL',
                    areaName: 'Fence area',
                    latitude: 0,
                    longitude: 0,
                    occurredAt: new Date(),
                    attributes: {},
                    topic: 'hazard-events',
                    correlationId: 'lease-integration',
                    lease: token,
                };
                await hazards.upsertAndEnqueue(input);
                await pending.save({ warning_id: 'pending-fence', related_event_id: 'future' }, token);
                const [event] = await outbox.findUnpublished(1);
                const statesBefore = await states.findAll();
                const old = token;
                await expire();
                const next = await repos[(owner + 1) % 3].acquireOrRenew('replacement');
                token = { ownerId: next.ownerId, epoch: next.epoch };
                assert.ok(token.epoch > old.epoch);
                for (const work of [
                    () => hazards.upsertAndEnqueue(input),
                    () => hazards.upsertAndEnqueue({ ...input, sourceRefId: 'stale-insert' }),
                    () => states.recordSuccessfulPoll('BMKG_SEISMIC', new Date(), old),
                    () => states.recordFailedPoll('BMKG_SEISMIC', 'old failure', new Date(), old),
                    () => pending.save({ warning_id: 'stale-warning' }, old),
                    () => pending.remove('pending-fence', old),
                    () => outbox.markPublished(event.outboxEventId, old),
                    () => outbox.recordPublishFailure(event.outboxEventId, 'old failure', old),
                ])
                    await assert.rejects(work(), LeaseLostError);
                assert.equal(await db.collection('hazard_events').countDocuments(), 1);
                assert.equal((await pending.findOldest(10)).length, 1);
                assert.equal((await outbox.findUnpublished(10)).length, 1);
                assert.deepEqual(await states.findAll(), statesBefore);
                await repos[0].release(old);
                assert.equal((await repos[0].inspect()).ownerId, 'replacement');
            }
        );

        await t.test('the same process reacquiring an expired lease gets a new epoch', async () => {
            const old = token;
            await expire();
            const next = await repos[0].acquireOrRenew(old.ownerId);
            token = { ownerId: next.ownerId, epoch: next.epoch };
            assert.ok(token.epoch > old.epoch);
            await assert.rejects(repos[0].requireActive(old), LeaseLostError);
        });

        await t.test(
            'a frozen open transaction cannot commit after replacement, and does not block takeover for 60s',
            async () => {
                await repos[0].acquireOrRenew(token.ownerId);
                let resume;
                let entered;
                const paused = new Promise((resolve) => {
                    resume = resolve;
                });
                const ready = new Promise((resolve) => {
                    entered = resolve;
                });
                const old = token;
                const transaction = repos[0].withLease(old, async (session) => {
                    await db.collection('fence_probes').insertOne({ _id: 'old-transaction' }, { session });
                    entered();
                    await paused;
                });
                // Attach a rejection handler while the callback is deliberately suspended.
                const finished = transaction.then(
                    () => null,
                    (error) => error
                );
                await ready;
                const start = performance.now();
                let next;
                try {
                    while (performance.now() - start < 45_000) {
                        next = await repos[1].acquireOrRenew('after-freeze').catch(() => null);
                        if (next) break;
                        await delay(300);
                    }
                } finally {
                    resume();
                }
                assert.ok(next, 'A database-side transaction timeout must unblock replacement');
                assert.ok(performance.now() - start < 60_000);
                assert.ok(next.epoch > old.epoch);
                assert.ok(await finished, 'The old transaction must reject instead of committing');
                assert.equal(await db.collection('fence_probes').countDocuments({ _id: 'old-transaction' }), 0);
                token = { ownerId: next.ownerId, epoch: next.epoch };
                await hazards.upsertAndEnqueue({ ...input, sourceRefId: 'new-owner', lease: token });
                assert.equal(await db.collection('hazard_events').countDocuments(), 2);
            }
        );
    } finally {
        await db.dropDatabase();
        await Promise.all(stores.map((store) => store.close()));
    }
});
