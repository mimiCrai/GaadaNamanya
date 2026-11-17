require('reflect-metadata');
// Unique names per run so the test never touches the real satellite.raw / checkpoint group.
const RUN = `it-${Date.now()}`;
process.env.SATELLITE_RAW_TOPIC = `satellite.raw.${RUN}`;
process.env.SATELLITE_CHECKPOINT_GROUP = `bnpb-satellite-checkpoint-${RUN}`;
process.env.KAFKA_SATELLITE_TRANSACTIONAL_ID = `bnpb-aggregator-satellite-${RUN}`;
process.env.BACKGROUND_LEASE_MS = '30000';
process.env.BACKGROUND_LEASE_RENEW_MS = '2000';
process.env.LEASE_OPERATION_TIMEOUT_MS = '3000';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Kafka } = require('kafkajs');
const { CanonicalStore } = require('../../dist/src/db');
const { runMigrations } = require('../../dist/src/db/migration-runner');
const { BackgroundLeaseRepository } = require('../../dist/src/repositories/background-lease.repository');
const { LeaseLostError, backgroundLeaseId } = require('../../dist/src/db/schema/background-leases');
const { SatelliteLogWriter } = require('../../dist/src/services/satellite-log-writer.service');
const env = require('../../dist/src/util/env').default;

const kafka = new Kafka({ clientId: `satellite-it-${RUN}`, brokers: env.KAFKA_BROKERS });

function records(from, to, kind = 'detection') {
    const out = [];
    for (let offset = from; offset <= to; offset++) {
        out.push({
            offset,
            kind,
            receivedAt: new Date().toISOString(),
            dataRaw: `{"offset":${offset},"frp":367.0}`,
            correlationId: RUN,
        });
    }
    return out;
}

/** All committed records of the topic (read_committed), as feed offsets in log order. */
async function readCommitted(topic) {
    const admin = kafka.admin();
    await admin.connect();
    const [partition] = await admin.fetchTopicOffsets(topic);
    await admin.disconnect();
    const high = Number(partition.high);
    const consumer = kafka.consumer({ groupId: `reader-${RUN}-${Math.random()}`, readUncommitted: false });
    const seen = [];
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    await new Promise((resolve) => {
        let idle = setTimeout(resolve, 8_000);
        consumer.run({
            autoCommit: false,
            eachMessage: async ({ message }) => {
                seen.push({ key: message.key.toString(), value: JSON.parse(message.value.toString()) });
                clearTimeout(idle);
                idle = setTimeout(resolve, Number(message.offset) >= high - 1 ? 200 : 3_000);
            },
        });
    });
    await consumer.disconnect();
    return seen;
}

test('satellite.raw durable append, checkpoint and fencing (Kafka + Mongo lease)', { timeout: 180_000 }, async (t) => {
    assert.match(process.env.DATABASE_NAME, /_integration$/);
    const store = new CanonicalStore(
        process.env.DATABASE_URL,
        process.env.DATABASE_NAME.replace(/_integration$/, '_satellite_integration')
    );
    await store.connect();
    const admin = kafka.admin();
    await admin.connect();
    const writers = [];
    try {
        await store.database.dropDatabase();
        await runMigrations(store.database);
        await admin.createTopics({
            topics: [{ topic: env.SATELLITE_RAW_TOPIC, numPartitions: 1, replicationFactor: 1 }],
            waitForLeaders: true,
        });
        const leases = new BackgroundLeaseRepository(store);
        const leaseA = await leases.acquireOrRenew('instance-a');
        const tokenA = { ownerId: 'instance-a', epoch: leaseA.epoch };
        // No renewal loop runs in this test: renew explicitly (same owner, unexpired → same epoch).
        const renew = async (token) => assert.equal((await leases.acquireOrRenew(token.ownerId)).epoch, token.epoch);

        await t.test('empty topic: checkpoint is 0', async () => {
            const writer = new SatelliteLogWriter(leases);
            writers.push(writer);
            await writer.prepare(tokenA);
            assert.equal(await writer.readCheckpoint(), 0);
            await writer.close();
        });

        let writerA;
        await t.test('records and checkpoint commit atomically; checkpoint is read back from the broker', async () => {
            writerA = new SatelliteLogWriter(leases);
            writers.push(writerA);
            await renew(tokenA);
            await writerA.prepare(tokenA);
            assert.equal(await writerA.readCheckpoint(), 0);
            await writerA.append(records(0, 4), tokenA);
            await writerA.append([...records(5, 5, 'heartbeat'), ...records(6, 9)], tokenA);
            // DUGAAN Tahap 2: the broker accepts a group offset (10) that is not an offset of the log itself.
            assert.equal(await writerA.readCheckpoint(), 10);
            const fresh = new SatelliteLogWriter(leases);
            writers.push(fresh);
            await fresh.prepare(tokenA);
            assert.equal(await fresh.readCheckpoint(), 10, 'a new process reads the same checkpoint');
            await fresh.close();
            const log = await readCommitted(env.SATELLITE_RAW_TOPIC);
            assert.deepEqual(
                log.map((r) => r.key),
                ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
            );
            assert.equal(log[5].value.kind, 'heartbeat');
            assert.match(JSON.stringify(log[0].value), /367\.0/);
        });

        await t.test('a non-consecutive batch never reaches the log', async () => {
            await renew(tokenA);
            await writerA.prepare(tokenA);
            await assert.rejects(writerA.append([...records(10, 10), ...records(12, 12)], tokenA), /not consecutive/);
        });

        await t.test(
            'review #1: a batch that does not start at the durable checkpoint never reaches the log',
            async () => {
                await renew(tokenA);
                await writerA.prepare(tokenA);
                // 10 is the next offset; a batch starting at 11 would make the checkpoint skip 10 forever.
                await assert.rejects(writerA.append(records(11, 12), tokenA), { name: 'SatelliteContinuityError' });
                await assert.rejects(writerA.append(records(9, 9), tokenA), { name: 'SatelliteContinuityError' });
                assert.equal(await writerA.readCheckpoint(), 10);
                const log = await readCommitted(env.SATELLITE_RAW_TOPIC);
                assert.deepEqual(
                    log.map((r) => r.key),
                    ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
                );
                const unread = new SatelliteLogWriter(leases);
                writers.push(unread);
                await unread.prepare(tokenA);
                await assert.rejects(unread.append(records(10, 10), tokenA), /before the checkpoint was read/);
                await unread.close();
            }
        );

        let tokenB;
        let writerB;
        await t.test('new leader fences a zombie whose lease check already passed', async () => {
            await writerA.prepare(tokenA);
            // The zombie: it passed requireActive before freezing, so only Kafka fencing can stop it.
            const zombie = new SatelliteLogWriter({ requireActive: async () => new Date() });
            writers.push(zombie);
            await zombie.prepare(tokenA);
            assert.equal(await zombie.readCheckpoint(), 10);
            await store.database
                .collection('background_leases')
                .updateOne({ _id: backgroundLeaseId }, { $set: { expiresAt: new Date(0) } });
            const leaseB = await leases.acquireOrRenew('instance-b');
            tokenB = { ownerId: 'instance-b', epoch: leaseB.epoch };
            assert.ok(tokenB.epoch > tokenA.epoch);
            writerB = new SatelliteLogWriter(leases);
            writers.push(writerB);
            await writerB.prepare(tokenB); // InitProducerId bumps the producer epoch
            await assert.rejects(zombie.append(records(10, 12), tokenA), LeaseLostError);
            assert.equal(await writerB.readCheckpoint(), 10);
        });

        await t.test('the old leader is also stopped by the lease check', async () => {
            await assert.rejects(writerA.append(records(10, 10), tokenA), LeaseLostError);
        });

        await t.test('a transaction left open by a zombie is aborted when the new leader prepares', async () => {
            const raw = kafka.producer({
                transactionalId: env.KAFKA_SATELLITE_TRANSACTIONAL_ID,
                idempotent: true,
                maxInFlightRequests: 1,
            });
            await raw.connect();
            const open = await raw.transaction();
            await open.send({ topic: env.SATELLITE_RAW_TOPIC, messages: [{ key: '10', value: '{"zombie":true}' }] });
            // Not committed. A new leader epoch arrives:
            await writerB.close();
            const writerC = new SatelliteLogWriter(leases);
            writers.push(writerC);
            await renew(tokenB);
            await writerC.prepare(tokenB);
            assert.equal(await writerC.readCheckpoint(), 10);
            await writerC.append(records(10, 11), tokenB);
            await assert.rejects(open.commit());
            await raw.disconnect().catch(() => undefined);
            const log = await readCommitted(env.SATELLITE_RAW_TOPIC);
            assert.deepEqual(
                log.map((r) => r.key),
                ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']
            );
            assert.ok(!log.some((r) => r.value.zombie), 'zombie record is not visible to read_committed');
            await writerC.close();
        });

        await t.test(
            'missing checkpoint on a non-empty topic is rebuilt from the tail, never restarted at 0',
            async () => {
                const group = env.SATELLITE_CHECKPOINT_GROUP;
                env.SATELLITE_CHECKPOINT_GROUP = `${group}-lost`;
                try {
                    const writer = new SatelliteLogWriter(leases);
                    writers.push(writer);
                    await renew(tokenB);
                    await writer.prepare(tokenB);
                    assert.equal(await writer.readCheckpoint(), 12);
                    await writer.close();
                } finally {
                    env.SATELLITE_CHECKPOINT_GROUP = group;
                }
            }
        );
    } finally {
        await Promise.all(writers.map((writer) => writer.close().catch(() => undefined)));
        await admin.deleteTopics({ topics: [env.SATELLITE_RAW_TOPIC] }).catch(() => undefined);
        await admin.disconnect();
        await store.database.dropDatabase().catch(() => undefined);
        await store.close();
    }
});
