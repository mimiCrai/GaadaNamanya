// Integration: unprocessed-message store against the real sharded cluster (through mongos).
// Run: DATABASE_URL=mongodb://<root>@canonical-store:27017/?authSource=admin DATABASE_NAME=canonical_store_integration \
//      DLQ_CLAIM_MS=1500 npm run build && node --test tests/integration/unprocessed.test.cjs
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

process.env.DLQ_CLAIM_MS ??= '1500';
const { CanonicalStore } = require('../../dist/src/db');
const { runMigrations } = require('../../dist/src/db/migration-runner');
const { BackgroundLeaseRepository } = require('../../dist/src/repositories/background-lease.repository');
const { PayloadStore } = require('../../dist/src/repositories/payload-store.repository');
const { UnprocessedMessageRepository } = require('../../dist/src/repositories/unprocessed-message.repository');
const { CanonicalReadRepository } = require('../../dist/src/repositories/canonical-read.repository');
const { StorageTopologyService } = require('../../dist/src/services/storage-topology.service');
const { UnprocessedQueryService } = require('../../dist/src/services/unprocessed-query.service');
const { ProcessingError } = require('../../dist/src/libs/processing-error');
const { readLimited } = require('../../dist/src/libs/safe-decode');

const context = { kind: 'poll.volcanic-report', endpoint: 'GET /volcanic-reports', topic: null };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('unprocessed messages on the sharded canonical store', { timeout: 180_000 }, async (t) => {
    const name = process.env.DATABASE_NAME;
    assert.match(name, /_integration$/, 'Use an isolated database ending in _integration');
    const store = new CanonicalStore(process.env.DATABASE_URL, name);
    await store.client.connect();
    assert.equal((await store.client.db('admin').command({ hello: 1 })).msg, 'isdbgrid', 'Tests must run through mongos');
    await store.database.dropDatabase();
    let leaseTimer;
    try {
        await runMigrations(store.database);
        const leases = new BackgroundLeaseRepository(store);
        const grant = await leases.acquireOrRenew('unprocessed-integration');
        const lease = { ownerId: grant.ownerId, epoch: grant.epoch };
        leaseTimer = setInterval(() => void leases.acquireOrRenew(lease.ownerId).catch(() => undefined), 2000);
        const payloads = new PayloadStore(store);
        const repo = new UnprocessedMessageRepository(store, leases, payloads);

        await t.test('collection is sharded on hashed _id and GridFS chunks on {files_id, n}', async () => {
            const config = store.client.db('config').collection('collections');
            assert.deepEqual((await config.findOne({ _id: `${name}.unprocessed_messages` })).key, { _id: 'hashed' });
            assert.deepEqual((await config.findOne({ _id: `${name}.unprocessed_payloads.chunks` })).key, { files_id: 1, n: 1 });
        });

        await t.test('the same broken bytes received repeatedly become one entry', async () => {
            const bytes = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xc3, 0x28, 0x7d]);
            const input = {
                source: 'PVMBG',
                context,
                payload: { kind: 'inline', bytes },
                contentType: 'application/json',
                correlationId: 'c1',
                error: new ProcessingError('invalid_utf8', 'byte UTF-8 tidak valid pada offset 5'),
            };
            const first = await repo.record(input, lease);
            const second = await repo.record({ ...input, correlationId: 'c2' }, lease);
            assert.equal(first.messageId, second.messageId);
            assert.equal(first.created, true);
            assert.equal(second.created, false);
            const entry = await repo.findById(first.messageId);
            assert.equal(entry.seenCount, 2);
            assert.equal(entry.status, 'parked');
            assert.equal(entry.correlationId, 'c1');
            assert.ok(Buffer.from(entry.payload.buffer).equals(bytes), 'invalid UTF-8 stored byte-for-byte');
        });

        await t.test('a 50 MB payload is stored in GridFS intact', async () => {
            const total = 50 * 1024 * 1024;
            const sourceHash = createHash('sha256');
            async function* source() {
                for (let produced = 0; produced < total; produced += 256 * 1024) {
                    const chunk = Buffer.alloc(Math.min(256 * 1024, total - produced), produced % 251);
                    sourceHash.update(chunk);
                    yield chunk;
                }
            }
            const read = await readLimited(source(), 5 * 1024 * 1024, () => payloads.openSink({ test: true }));
            assert.equal(read.kind, 'overflow');
            const recorded = await repo.record(
                {
                    source: 'PVMBG',
                    context: { ...context, kind: 'poll.volcanic-response' },
                    payload: { kind: 'stored', ref: read.ref, size: read.size, sha256: read.sha256 },
                    contentType: 'application/json',
                    correlationId: 'big',
                    error: new ProcessingError('payload_too_large', `ukuran ${total} byte melebihi batas`),
                },
                lease
            );
            const entry = await repo.findById(recorded.messageId);
            assert.equal(entry.payload, null);
            assert.equal(entry.sizeBytes, total);
            const stored = createHash('sha256');
            for await (const chunk of payloads.openDownload(entry.payloadRef)) stored.update(chunk);
            const expected = sourceHash.digest('hex');
            assert.equal(stored.digest('hex'), expected);
            assert.equal(entry.sha256, expected);
        });

        await t.test('findOneAndUpdate without the shard key on MongoDB 7.0 (records the observed behaviour)', async () => {
            let outcome;
            try {
                await store.collection('unprocessed_messages').findOneAndUpdate({ status: 'nope' }, { $set: { x: 1 } });
                outcome = 'accepted';
            } catch (error) {
                outcome = `rejected: ${error.codeName ?? error.code ?? error.message}`;
            }
            t.diagnostic(`findOneAndUpdate without shard key: ${outcome}`);
        });

        await t.test('two concurrent claims on the same entry: exactly one wins; expired claims are taken over', async () => {
            const input = (i) => ({
                source: 'PVMBG',
                context,
                payload: { kind: 'inline', bytes: Buffer.from(`{"report_id":"retry-${i}"}`) },
                contentType: 'application/json',
                correlationId: `r${i}`,
                error: new ProcessingError('store_unavailable', 'shard tidak terjangkau'),
            });
            const ids = [];
            for (let i = 0; i < 20; i++) ids.push((await repo.record(input(i), lease)).messageId);
            await store.collection('unprocessed_messages').updateMany({ _id: { $in: ids } }, { $set: { nextAttemptAt: new Date(0) } });

            for (const id of ids) {
                const results = await Promise.all([repo.claim(id, 'replica-a', 1), repo.claim(id, 'replica-b', 2)]);
                assert.equal(results.filter(Boolean).length, 1, `exactly one claim wins for ${id}`);
            }
            const owner = (await repo.findById(ids[0])).claimedBy;
            assert.equal(await repo.claim(ids[0], 'replica-c', 3), null, 'live claim is respected');
            await sleep(Number(process.env.DLQ_CLAIM_MS) + 500);
            const taken = await repo.claim(ids[0], 'replica-c', 3);
            assert.equal(taken.claimedBy, 'replica-c', `expired claim of ${owner} taken over`);

            const stale = { ...(await repo.findById(ids[1])), claimedBy: 'not-the-owner' };
            assert.equal(await repo.complete(stale, lease, { kind: 'recovered', hazardId: null }), false);
            assert.equal(await repo.complete(taken, lease, { kind: 'recovered', hazardId: 'hz-1' }), true);
            assert.equal((await repo.findById(ids[0])).status, 'recovered');
        });

        await t.test('audit pagination over the real store hides recovered entries', async () => {
            const query = new UnprocessedQueryService(new CanonicalReadRepository(store, new StorageTopologyService(store)), repo);
            const seen = [];
            let cursor;
            do {
                const page = await query.audit({ source: 'PVMBG', limit: 7, cursor });
                assert.equal(page.partial, false);
                for (const item of page.items) {
                    assert.deepEqual(Object.keys(item), ['message_id', 'source', 'received_at', 'reason', 'retryable', 'attempts', 'status']);
                    assert.notEqual(item.status, 'recovered');
                }
                seen.push(...page.items.map((item) => item.message_id));
                cursor = page.next_cursor ?? undefined;
            } while (cursor);
            assert.equal(new Set(seen).size, seen.length);
            assert.equal(seen.length, 21); // 1 utf8 + 1 large + 20 retrying - 1 recovered
        });
    } finally {
        clearInterval(leaseTimer);
        await store.database.dropDatabase().catch(() => undefined);
        await store.close();
    }
});
