/**
 * Kafka-only integration suite for the satellite.raw writer (review #2 and #4). Needs a real broker with
 * transactions (single node: transaction.state.log.replication.factor=1, min.isr=1), no MongoDB: the lease
 * check is a stub. Runs against dist/ like the other integration suites.
 *
 *   in the integration project:  npm run test:integration           (KAFKA_BROKERS=kafka:29092)
 *   from the host:               npm run build && npm run test:integration:kafka   (KAFKA_BROKERS=localhost:9092)
 */
require('reflect-metadata');
const RUN = `it-${Date.now()}`;
// env.ts validates the whole service config; only Kafka is used here.
const defaults = {
    DATABASE_URL: 'mongodb://unused:27017',
    BNPB_AUDIT_TOKEN: 'x'.repeat(32),
    BNPB_INTERNAL_API_KEY: 'x'.repeat(32),
    KAFKA_BROKERS: 'localhost:9092',
    BMKG_BASE_URL: 'http://unused',
    BMKG_API_KEY: 'unused',
    PVMBG_BASE_URL: 'http://unused',
    PVMBG_TOKEN: 'unused',
    BACKGROUND_LEASE_MS: '30000',
};
for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Kafka } = require('kafkajs');
const { SatelliteLogWriter } = require('../../dist/src/services/satellite-log-writer.service');
const env = require('../../dist/src/util/env').default;

const kafka = new Kafka({ clientId: `satellite-kafka-it-${RUN}`, brokers: env.KAFKA_BROKERS });
const lease = { ownerId: 'instance-it', epoch: 1 };

/** Lease check stub; `failAt` makes the n-th call throw (the second call of an append is the one before commit). */
function leaseStub() {
    const stub = {
        calls: 0,
        failAt: null,
        async requireActive() {
            stub.calls++;
            if (stub.failAt === stub.calls) throw new Error('lease store unavailable (test)');
            return new Date();
        },
    };
    return stub;
}

function records(from, to, dataRaw = (offset) => `{"offset":${offset},"frp":367.0}`) {
    const out = [];
    for (let offset = from; offset <= to; offset++) {
        out.push({
            offset,
            kind: 'detection',
            receivedAt: new Date().toISOString(),
            dataRaw: dataRaw(offset),
            correlationId: RUN,
        });
    }
    return out;
}

/** A valid detection, padded to `bytes` of data text (padding is an extra field, as unknown fields pass through). */
function paddedDetection(offset, bytes) {
    const head = `{"offset":${offset},"detection":{"acq_date":"2026-11-14","acq_time":2350,"confidence":"n","frp":11.70,"latitude":-8.35726,"longitude":122.48591,"satellite":"N21","pad":"`;
    const tail = '"}}';
    return head + 'p'.repeat(Math.max(0, bytes - head.length - tail.length)) + tail;
}

let n = 0;
/** Fresh topic, checkpoint group and transactional id per scenario, written into env (the writer reads env per call). */
async function scenario(admin) {
    n++;
    env.SATELLITE_RAW_TOPIC = `satellite.raw.${RUN}.${n}`;
    env.SATELLITE_CHECKPOINT_GROUP = `bnpb-satellite-checkpoint-${RUN}-${n}`;
    env.KAFKA_SATELLITE_TRANSACTIONAL_ID = `bnpb-aggregator-satellite-${RUN}-${n}`;
    await admin.createTopics({
        topics: [{ topic: env.SATELLITE_RAW_TOPIC, numPartitions: 1, replicationFactor: 1 }],
        waitForLeaders: true,
    });
    return env.SATELLITE_RAW_TOPIC;
}

/** Simulates a lost checkpoint group (expired offsets) for the next readCheckpoint. */
function withLostGroup() {
    env.SATELLITE_CHECKPOINT_GROUP = `${env.SATELLITE_CHECKPOINT_GROUP}-lost-${Math.random().toString(36).slice(2)}`;
}

async function physicalOffsets(admin, topic) {
    const [partition] = await admin.fetchTopicOffsets(topic);
    return { low: Number(partition.low), high: Number(partition.high) };
}

/** All committed records (read_committed), as feed offsets in log order. */
async function readCommitted(admin, topic) {
    const { high } = await physicalOffsets(admin, topic);
    const consumer = kafka.consumer({ groupId: `reader-${RUN}-${Math.random()}`, readUncommitted: false });
    const seen = [];
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    await new Promise((resolve) => {
        const deadline = setTimeout(resolve, 15_000);
        const done = () => {
            clearTimeout(deadline);
            resolve();
        };
        consumer.on(consumer.events.END_BATCH_PROCESS, ({ payload }) => {
            if (Number(payload.lastOffset) >= high - 1) done();
        });
        consumer.run({
            autoCommit: false,
            eachMessage: async ({ message }) => {
                seen.push(Number(message.key.toString()));
            },
        });
    });
    await consumer.disconnect();
    return seen;
}

/** A raw transactional producer with the writer's transactional id: sends feed offsets and leaves/aborts. */
async function rawTransaction(topic, offsets, end) {
    const producer = kafka.producer({
        transactionalId: env.KAFKA_SATELLITE_TRANSACTIONAL_ID,
        idempotent: true,
        maxInFlightRequests: 1,
        transactionTimeout: 60_000,
    });
    await producer.connect();
    const transaction = await producer.transaction();
    await transaction.send({
        topic,
        acks: -1,
        messages: offsets.map((offset) => ({ key: String(offset), value: `{"offset":${offset},"aborted":true}` })),
    });
    if (end === 'abort') {
        await transaction.abort();
        await producer.disconnect();
        return null;
    }
    return producer; // 'crash': left open, never committed or aborted
}

test('satellite.raw writer against a real broker (review #2, #4)', { timeout: 300_000 }, async (t) => {
    const admin = kafka.admin();
    await admin.connect();
    const writers = [];
    const topics = [];
    const writer = (stub = leaseStub()) => {
        const created = new SatelliteLogWriter(stub);
        writers.push(created);
        return created;
    };
    try {
        await t.test('#2: the first transaction is aborted → checkpoint rebuild returns 0, not an error', async () => {
            const topic = await scenario(admin);
            topics.push(topic);
            const stub = leaseStub();
            const first = writer(stub);
            await first.prepare(lease);
            assert.equal(await first.readCheckpoint(), 0);
            stub.failAt = 2; // the check before commit fails → the writer aborts its own transaction
            await assert.rejects(first.append(records(0, 0), lease), /lease store unavailable/);

            // The abort marker is written asynchronously after EndTxn; wait until it is visible (reviewer: low=0, high=2).
            let physical = await physicalOffsets(admin, topic);
            for (let i = 0; i < 100 && physical.high <= physical.low; i++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                physical = await physicalOffsets(admin, topic);
            }
            assert.deepEqual(physical, { low: 0, high: 2 }, 'aborted record + abort marker still move the log end');

            const next = writer();
            await next.prepare(lease);
            assert.equal(await next.readCheckpoint(), 0, 'nothing committed: start at 0');
            await next.append(records(0, 1), lease);
            assert.equal(await next.readCheckpoint(), 2);
            assert.deepEqual(await readCommitted(admin, topic), [0, 1]);
        });

        await t.test('#2a: commit 0–4, then an aborted transaction with 5–6 → rebuilt checkpoint is 5', async () => {
            const topic = await scenario(admin);
            topics.push(topic);
            const w = writer();
            await w.prepare(lease);
            assert.equal(await w.readCheckpoint(), 0);
            await w.append(records(0, 4), lease);
            await w.close();
            await rawTransaction(topic, [5, 6], 'abort');

            withLostGroup();
            const next = writer();
            await next.prepare(lease);
            assert.equal(await next.readCheckpoint(), 5);
        });

        await t.test(
            "#2a': an aborted tail longer than the scan window still finds the last committed record",
            async () => {
                const topic = await scenario(admin);
                topics.push(topic);
                const w = writer();
                await w.prepare(lease);
                assert.equal(await w.readCheckpoint(), 0);
                await w.append(records(0, 2), lease);
                await w.close();
                for (let i = 0; i < 3; i++) await rawTransaction(topic, [3, 4, 5, 6], 'abort');

                withLostGroup();
                const next = writer();
                next.tailScanWindow = 4; // 15 aborted records + markers after offset 2: needs several windows backwards
                await next.prepare(lease);
                assert.equal(await next.readCheckpoint(), 3);
            }
        );

        await t.test(
            '#2b: producer crashes mid-transaction; the new producer fences it and the checkpoint is right',
            async () => {
                const topic = await scenario(admin);
                topics.push(topic);
                const w = writer();
                await w.prepare(lease);
                assert.equal(await w.readCheckpoint(), 0);
                await w.append(records(0, 4), lease);
                await w.close();
                const crashed = await rawTransaction(topic, [5, 6], 'crash');

                // Checkpoint group intact: read straight from the group.
                const next = writer();
                await next.prepare(lease); // InitProducerId aborts the open transaction
                assert.equal(await next.readCheckpoint(), 5);
                // Checkpoint group lost: the tail scan must reach the end (LSO == high after fencing).
                withLostGroup();
                const rebuilt = writer();
                await rebuilt.prepare(lease);
                assert.equal(await rebuilt.readCheckpoint(), 5);
                await rebuilt.append(records(5, 6), lease);
                assert.deepEqual(await readCommitted(admin, topic), [0, 1, 2, 3, 4, 5, 6]);
                await crashed.disconnect().catch(() => undefined);
            }
        );

        await t.test("extra: a checkpoint read right after the writer's own commit is never stale", async () => {
            const topic = await scenario(admin);
            topics.push(topic);
            const w = writer();
            await w.prepare(lease);
            assert.equal(await w.readCheckpoint(), 0);
            for (let offset = 0; offset < 30; offset++) {
                await w.append(records(offset, offset), lease);
                await w.prepare(lease); // same epoch: a session restart without a new InitProducerId
                assert.equal(await w.readCheckpoint(), offset + 1, `checkpoint after committing ${offset}`);
            }
        });

        await t.test(
            '#4: two ~600 KB records in one append are committed (split by bytes, same transaction)',
            async () => {
                const topic = await scenario(admin);
                topics.push(topic);
                const w = writer();
                await w.prepare(lease);
                assert.equal(await w.readCheckpoint(), 0);
                const big = records(0, 1, (offset) => paddedDetection(offset, 600_000));
                assert.ok(JSON.stringify({ data_raw: big[0].dataRaw }).length > 600_000);
                await w.append([...big, ...records(2, 3)], lease);
                assert.equal(await w.readCheckpoint(), 4);
                assert.deepEqual(await readCommitted(admin, topic), [0, 1, 2, 3]);
            }
        );

        await t.test('#4: a single record above the topic limit is refused before it reaches Kafka', async () => {
            const topic = await scenario(admin);
            topics.push(topic);
            const w = writer();
            await w.prepare(lease);
            assert.equal(await w.readCheckpoint(), 0);
            assert.ok(
                w.maxRecordBytes() < 1_048_588,
                `limit follows the topic's max.message.bytes (${w.maxRecordBytes()})`
            );
            const huge = records(0, 0, (offset) => paddedDetection(offset, 1_200_000));
            await assert.rejects(w.append(huge, lease), { name: 'SatelliteRecordTooLargeError' });
            assert.equal(await w.readCheckpoint(), 0);
        });
    } finally {
        await Promise.all(writers.map((w) => w.close().catch(() => undefined)));
        await admin.deleteTopics({ topics }).catch(() => undefined);
        await admin.disconnect();
    }
});
