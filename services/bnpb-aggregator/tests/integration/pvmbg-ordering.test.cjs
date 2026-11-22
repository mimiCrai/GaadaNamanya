// Integration (review #3): ordering per (source, source_ref_id) between the live PVMBG poll and DLQ replays,
// against the real sharded store (through mongos), with the real ingestion service, DLQ repository and retry worker.
// Run: DATABASE_URL=mongodb://<root>@canonical-store:27017/?authSource=admin DATABASE_NAME=canonical_store_integration \
//      npm run build && node --test tests/integration/pvmbg-ordering.test.cjs
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MongoNetworkError } = require('mongodb');

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

const report = (reportId, reportedAt, alertLevel, extra = {}) => ({
    report_id: reportId,
    volcano_id: 'MERAPI',
    alert_level: alertLevel,
    eruption_count_24h: 3,
    ash_column_height_m: 1200.5,
    reported_at: reportedAt,
    ...extra,
});

test('PVMBG ordering per source_ref_id: live poll vs DLQ replay (review #3)', { timeout: 180_000 }, async (t) => {
    const name = process.env.DATABASE_NAME;
    assert.match(name, /_integration$/, 'Use an isolated database ending in _integration');
    const store = new CanonicalStore(
        process.env.DATABASE_URL,
        name.replace(/_integration$/, '_pvmbg_order_integration')
    );
    await store.client.connect();
    await store.database.dropDatabase();
    let leaseTimer;
    try {
        await runMigrations(store.database);
        const leases = new BackgroundLeaseRepository(store);
        const grant = await leases.acquireOrRenew('pvmbg-order-integration');
        const lease = { ownerId: grant.ownerId, epoch: grant.epoch };
        leaseTimer = setInterval(() => void leases.acquireOrRenew(lease.ownerId).catch(() => undefined), 2000);
        const dlq = new UnprocessedMessageRepository(store, leases, new PayloadStore(store));
        const hazards = new HazardEventRepository(store, leases);
        // The store write fails transiently for the reports listed in `failFor` (one time each).
        const failFor = new Set();
        const flaky = Object.create(hazards);
        flaky.upsertAndEnqueue = async (input) => {
            const key = `${input.sourceRefId}@${input.occurredAt.toISOString()}@${input.severity}`;
            if (failFor.delete(key)) throw new MongoNetworkError('connection reset by peer (test)');
            return hazards.upsertAndEnqueue(input);
        };
        const ingestion = new HazardEventIngestionService(
            flaky,
            {},
            new UnprocessedRecorder(dlq),
            new OrderingSequenceRepository(store)
        );
        const registry = new UnprocessedHandlerRegistry(ingestion);
        const leadership = { current: () => lease, invalidate: () => undefined };
        const worker = new UnprocessedRetryService(dlq, registry, leadership);

        const messages = store.database.collection('unprocessed_messages');
        const outbox = store.database.collection('outbox_events');
        const hazardOf = (reportId) => hazards.findBySourceAndRefId('PVMBG', reportId);
        const outboxOf = async (reportId) =>
            outbox
                .find({ aggregateId: (await hazardOf(reportId)).hazardId })
                .sort({ createdAt: 1 })
                .toArray();
        const entriesOf = (reportId) => messages.find({ sourceRefId: reportId }).toArray();
        async function replayDue() {
            await messages.updateMany({ status: 'retrying' }, { $set: { nextAttemptAt: new Date(0) } });
            return worker.runOnce();
        }

        await t.test(
            'reviewer scenario: 10:00 Normal fails, 10:01 Awas succeeds, the 10:00 replay must not win',
            async () => {
                failFor.add('rv-1@2026-11-12T10:00:00.000Z@NORMAL');
                await ingestion.ingestVolcanicReports(
                    [report('rv-1', '2026-11-12T10:00:00Z', 'Normal')],
                    'poll-1',
                    lease
                );
                const [entry] = await entriesOf('rv-1');
                assert.equal(entry.status, 'retrying', 'transient store error → retrying');
                await ingestion.ingestVolcanicReports(
                    [report('rv-1', '2026-11-12T10:01:00Z', 'Awas')],
                    'poll-2',
                    lease
                );

                assert.equal(await replayDue(), 1);
                const hazard = await hazardOf('rv-1');
                assert.equal(hazard.severity, 'AWAS');
                assert.equal(hazard.occurredAt.toISOString(), '2026-11-12T10:01:00.000Z');
                assert.equal(hazard.version, undefined, 'the ordering version is internal, never returned by reads');
                const events = await outboxOf('rv-1');
                assert.deepEqual(
                    events.map((e) => [e.eventType, e.payload.hazard.severity]),
                    [['hazard.created', 'AWAS']],
                    'no stale update was enqueued'
                );
                const [after] = await entriesOf('rv-1');
                assert.equal(after.status, 'superseded', 'closed as superseded, not parked again');
                assert.equal(await messages.countDocuments({ status: { $in: ['retrying', 'parked'] } }), 0);
            }
        );

        await t.test('a replay that is newer than what is stored is applied', async () => {
            failFor.add('rv-2@2026-11-12T10:02:00.000Z@SIAGA');
            await ingestion.ingestVolcanicReports([report('rv-2', '2026-11-12T10:01:00Z', 'Waspada')], 'poll-1', lease);
            await ingestion.ingestVolcanicReports([report('rv-2', '2026-11-12T10:02:00Z', 'Siaga')], 'poll-2', lease);
            assert.equal((await hazardOf('rv-2')).severity, 'WASPADA');
            await replayDue();
            assert.equal((await hazardOf('rv-2')).severity, 'SIAGA');
            assert.equal((await entriesOf('rv-2'))[0].status, 'recovered');
            assert.deepEqual(
                (await outboxOf('rv-2')).map((e) => e.eventType),
                ['hazard.created', 'hazard.updated']
            );
        });

        await t.test('equal reported_at: the copy received later wins (tie-break by receive order)', async () => {
            failFor.add('rv-3@2026-11-12T10:05:00.000Z@SIAGA');
            await ingestion.ingestVolcanicReports([report('rv-3', '2026-11-12T10:05:00Z', 'Siaga')], 'poll-1', lease);
            await ingestion.ingestVolcanicReports([report('rv-3', '2026-11-12T10:05:00Z', 'Awas')], 'poll-2', lease);
            await replayDue();
            assert.equal((await hazardOf('rv-3')).severity, 'AWAS');
            assert.equal((await entriesOf('rv-3'))[0].status, 'superseded');
        });

        await t.test('re-receiving the stored report unchanged moves its version (no outbox event)', async () => {
            failFor.add('rv-4@2026-11-12T10:01:00.000Z@SIAGA');
            await ingestion.ingestVolcanicReports([report('rv-4', '2026-11-12T10:01:00Z', 'Awas')], 'poll-1', lease);
            await ingestion.ingestVolcanicReports([report('rv-4', '2026-11-12T10:01:00Z', 'Siaga')], 'poll-2', lease);
            // poll-3 (poll overlap) returns the Awas copy again: identical content, received after the Siaga copy.
            await ingestion.ingestVolcanicReports([report('rv-4', '2026-11-12T10:01:00Z', 'Awas')], 'poll-3', lease);
            assert.deepEqual(
                (await outboxOf('rv-4')).map((e) => e.eventType),
                ['hazard.created']
            );
            await replayDue();
            assert.equal((await hazardOf('rv-4')).severity, 'AWAS', 'the Siaga copy was received before poll-3');
            assert.equal((await entriesOf('rv-4'))[0].status, 'superseded');
            assert.deepEqual(
                (await outboxOf('rv-4')).map((e) => e.eventType),
                ['hazard.created']
            );
        });

        await t.test(
            'a live poll returning an older report (poll overlap) changes nothing and enqueues nothing',
            async () => {
                await ingestion.ingestVolcanicReports(
                    [report('rv-5', '2026-11-12T11:00:00Z', 'Awas')],
                    'poll-1',
                    lease
                );
                await ingestion.ingestVolcanicReports(
                    [report('rv-5', '2026-11-12T10:00:00Z', 'Normal')],
                    'poll-2',
                    lease
                );
                assert.equal((await hazardOf('rv-5')).severity, 'AWAS');
                assert.deepEqual(
                    (await outboxOf('rv-5')).map((e) => e.eventType),
                    ['hazard.created']
                );
            }
        );

        // Review P2 (follow-up): the receive order must come from one consistent, persisted source.
        await t.test(
            'P2 case 1: same batch, Normal (fails) then Awas, same reported_at → replay keeps Awas',
            async () => {
                failFor.add('rv-p2a@2026-11-12T12:00:00.000Z@NORMAL');
                await ingestion.ingestVolcanicReports(
                    [
                        report('rv-p2a', '2026-11-12T12:00:00Z', 'Normal'),
                        report('rv-p2a', '2026-11-12T12:00:00Z', 'Awas'),
                    ],
                    'poll-1',
                    lease
                );
                assert.equal((await hazardOf('rv-p2a')).severity, 'AWAS');
                await replayDue();
                assert.equal((await hazardOf('rv-p2a')).severity, 'AWAS', 'Awas came later in the same batch');
                assert.equal((await entriesOf('rv-p2a'))[0].status, 'superseded');
                assert.deepEqual(
                    (await outboxOf('rv-p2a')).map((e) => e.payload.hazard.severity),
                    ['AWAS']
                );
            }
        );

        /** Runs `work` with the application clock (global Date, as the ingestion module sees it) moved by `ms`. */
        async function withAppClockShift(ms, work) {
            const SystemDate = Date;
            global.Date = new Proxy(SystemDate, {
                construct: (target, args, newTarget) =>
                    Reflect.construct(target, args.length ? args : [SystemDate.now() + ms], newTarget),
                get: (target, key, receiver) =>
                    key === 'now' ? () => SystemDate.now() + ms : Reflect.get(target, key, receiver),
            });
            try {
                return await work();
            } finally {
                global.Date = SystemDate;
            }
        }

        await t.test('P2 case 2: app clock moved back 45 s before the newer poll → replay keeps Awas', async () => {
            failFor.add('rv-p2b@2026-11-12T12:00:00.000Z@NORMAL');
            await ingestion.ingestVolcanicReports(
                [report('rv-p2b', '2026-11-12T12:00:00Z', 'Normal')],
                'poll-1',
                lease
            );
            await withAppClockShift(-45_000, () =>
                ingestion.ingestVolcanicReports([report('rv-p2b', '2026-11-12T12:00:00Z', 'Awas')], 'poll-2', lease)
            );
            assert.equal((await hazardOf('rv-p2b')).severity, 'AWAS');
            await replayDue();
            assert.equal((await hazardOf('rv-p2b')).severity, 'AWAS');
            assert.equal((await entriesOf('rv-p2b'))[0].status, 'superseded');
        });

        await t.test('P2 case 2b: app clock moved back 45 s, live polls only → the later poll still wins', async () => {
            await ingestion.ingestVolcanicReports(
                [report('rv-p2c', '2026-11-12T12:00:00Z', 'Normal')],
                'poll-1',
                lease
            );
            await withAppClockShift(-45_000, () =>
                ingestion.ingestVolcanicReports([report('rv-p2c', '2026-11-12T12:00:00Z', 'Awas')], 'poll-2', lease)
            );
            assert.equal((await hazardOf('rv-p2c')).severity, 'AWAS');
        });

        await t.test(
            'live poll and retry worker racing on the same report: the newest report wins every time',
            async () => {
                for (let i = 0; i < 5; i++) {
                    const id = `rv-race-${i}`;
                    failFor.add(`${id}@2026-11-12T10:00:00.000Z@NORMAL`);
                    await ingestion.ingestVolcanicReports(
                        [report(id, '2026-11-12T10:00:00Z', 'Normal')],
                        'poll-1',
                        lease
                    );
                    await messages.updateMany({ status: 'retrying' }, { $set: { nextAttemptAt: new Date(0) } });
                    await Promise.all([
                        worker.runOnce(),
                        ingestion.ingestVolcanicReports([report(id, '2026-11-12T10:01:00Z', 'Awas')], 'poll-2', lease),
                    ]);
                    await replayDue(); // an entry that lost a write conflict is retried
                    const hazard = await hazardOf(id);
                    assert.equal(hazard.severity, 'AWAS', `${id}: newest report must win`);
                    const events = await outboxOf(id);
                    const severities = events.map((e) => e.payload.hazard.severity);
                    const trace = events.map((e) => `${e.eventType}:${e.payload.hazard.severity}@${e.createdAt.toISOString()}`).join(', ');
                    assert.equal(severities.at(-1), 'AWAS', `${id}: last enqueued event is the newest report (${trace})`);
                    assert.ok(!severities.slice(severities.indexOf('AWAS')).includes('NORMAL'), `${id}: ${severities}`);
                }
            }
        );
    } finally {
        clearInterval(leaseTimer);
        await store.database.dropDatabase().catch(() => undefined);
        await store.close();
    }
});
