import { gunzipSync } from 'node:zlib';
import {
    HazardBatchOp,
    HazardBatchResult,
    IAggregatorClient,
    LateDetectionItem,
    StaleSnapshotError,
    StoredSnapshot,
    TransientAggregatorError,
    UnprocessedItem,
} from '../../src/clients/aggregator.client';
import { endToEndSeconds, processingSeconds } from '../../src/libs/metrics';
import { chunkOps, FirePipeline, PipelineOptions, PipelineStoppedError } from '../../src/services/fire-pipeline.service';
import { RawLogRecord } from '../../src/types/fire';
import { Det, LogBuilder } from '../helpers/fire-log';

// in-memory Aggregator with the same rules as POST /internal/hazards/batch (version guard + tombstone)
class FakeAggregator implements IAggregatorClient {
    hazards = new Map<string, { version: number; hazard: NonNullable<HazardBatchOp['hazard']> }>();
    tombstones = new Map<string, number>();
    late = new Map<number, LateDetectionItem>();
    dlq = new Map<string, UnprocessedItem>();
    snapshot: StoredSnapshot | null = null;
    stats: Record<string, unknown> | null = null;
    calls: string[] = [];
    failures = new Map<string, number>();

    private fail(operation: string) {
        this.calls.push(operation);
        const left = this.failures.get(operation) ?? 0;
        if (left > 0) {
            this.failures.set(operation, left - 1);
            throw new TransientAggregatorError(`${operation} down`);
        }
    }

    async applyHazards(ops: HazardBatchOp[]): Promise<HazardBatchResult[]> {
        this.fail('hazards');
        return ops.map((op) => {
            const id = op.source_ref_id;
            const stored = this.hazards.get(id);
            const tomb = this.tombstones.get(id);
            const base = { op: op.op, source_ref_id: id, hazard_id: `hz-${id}` };
            if ((tomb !== undefined && op.version < tomb) || (stored && op.version < stored.version)) {
                return { ...base, result: 'skipped' as const };
            }
            if (op.op === 'delete') {
                this.tombstones.set(id, Math.max(tomb ?? -1, op.version));
                return { ...base, result: this.hazards.delete(id) ? ('applied' as const) : ('unchanged' as const) };
            }
            const same = stored && JSON.stringify(stored.hazard) === JSON.stringify(op.hazard);
            this.hazards.set(id, { version: op.version, hazard: op.hazard! });
            return { ...base, result: same ? ('unchanged' as const) : ('applied' as const) };
        });
    }

    async recordLate(items: LateDetectionItem[]) {
        this.fail('late');
        for (const item of items) if (!this.late.has(item.offset)) this.late.set(item.offset, item);
    }

    async recordUnprocessed(item: UnprocessedItem) {
        this.fail('dlq');
        this.dlq.set(`${item.sourceRefId}`, item);
    }

    async putStats(_lastOffset: number, stats: Record<string, unknown>) {
        this.fail('stats');
        this.stats = stats;
    }

    async putSnapshot(body: Buffer, feedOffset: number, kafkaOffset: string | null) {
        this.fail('snapshot_put');
        if (this.snapshot && this.snapshot.feedOffset > feedOffset) throw new StaleSnapshotError(this.snapshot.feedOffset);
        this.snapshot = { body, feedOffset, kafkaOffset };
    }

    async getSnapshot() {
        this.fail('snapshot_get');
        return this.snapshot;
    }

    state() {
        return [...this.hazards.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    }
}

const options = (overrides: Partial<PipelineOptions> = {}): PipelineOptions => ({
    allowedLatenessMs: 120 * 60_000,
    instanceId: 'test',
    batchMaxOps: 500,
    batchMaxBytes: 3 * 1024 * 1024,
    snapshotEveryRecords: 3,
    snapshotIntervalMs: 60 * 60_000,
    backoffBaseMs: 1,
    backoffCapMs: 2,
    now: () => Date.parse('2026-11-15T12:00:05.000Z'),
    sleep: async () => undefined,
    ...overrides,
});

const messages = (records: RawLogRecord[]) =>
    records.map((record, index) => ({ offset: String(index), value: Buffer.from(JSON.stringify(record)) }));

const at = (lat: string, time: number, extra: Partial<Det> = {}): Det => ({ lat, lon: '113.80000', time, ...extra });

// two fires, a bridge that merges them, a dissolve by retract, a late detection and a broken record
function scenario(): RawLogRecord[] {
    const log = new LogBuilder()
        .heartbeat('2026-11-15T06:00:00Z')
        .detection(at('-2.50000', 500))
        .detection(at('-2.50800', 510, { conf: 'h', frp: '20.0' }))
        .detection(at('-2.52300', 520))
        .detection(at('-2.53100', 530, { sat: 'N21' }))
        .detection(at('-2.51550', 515))
        .update(at('-2.53100', 530, { sat: 'N21', frp: '12.50' }))
        .heartbeat('2026-11-15T10:00:00Z')
        .detection(at('-2.70000', 100, { date: '2026-11-14' }))
        .detection(at('-3.00000', 900))
        .detection(at('-3.00500', 905))
        .retract(at('-3.00500', 905))
        .unprocessed();
    return [...log.records, { v: 1, offset: log.records.length, kind: 'mystery', received_at: '2026-11-15T12:00:00.000Z' }];
}

async function runAll(client: FakeAggregator, records: RawLogRecord[], every = 3) {
    const pipeline = new FirePipeline(client, options({ snapshotEveryRecords: every }));
    const seek = Number(await pipeline.restore('c'));
    for (const message of messages(records).slice(seek)) {
        pipeline.ingest(message);
        if (pipeline.unflushedRecords >= 2) await pipeline.maybeSnapshot('c');
    }
    await pipeline.maybeSnapshot('c', undefined, true);
    return pipeline;
}

describe('FirePipeline (CP 3.4/3.5)', () => {
    it('writes one WILDFIRE per fire, deletes merged and dissolved fires, versions = feed offset of the last change', async () => {
        const client = new FakeAggregator();
        const pipeline = await runAll(client, scenario());
        const state = client.state();
        expect(state).toHaveLength(1);
        const [id, stored] = state[0];
        expect(pipeline.engine.hazards().map((hazard) => hazard.source_ref_id)).toEqual([id]);
        expect(stored.hazard).toMatchObject({
            hazard_type: 'WILDFIRE',
            severity: 'SIAGA',
            attributes: { detection_count: 5, satellites: ['N20', 'N21'], max_confidence: 'h', total_frp_mw: 47.5 },
        });
        expect(stored.version).toBe(6);
        expect(client.tombstones.size).toBeGreaterThanOrEqual(2);
    });

    it('stores late detections and broken records instead of dropping them silently', async () => {
        const client = new FakeAggregator();
        await runAll(client, scenario());
        expect([...client.late.values()]).toEqual([
            expect.objectContaining({ offset: 8, kind: 'detection', event_time: '2026-11-14T01:00:00Z', watermark: '2026-11-15T08:00:00Z' }),
        ]);
        expect([...client.dlq.keys()]).toEqual(['offset:13']);
        expect(client.dlq.get('offset:13')).toMatchObject({ kind: 'kafka.satellite-raw', detail: expect.stringContaining('mystery') });
        expect(client.stats).toMatchObject({ late_detections: 1, single_detections: expect.any(Number), low_excluded: 0 });
    });

    it('a record that is not JSON goes to the DLQ by Kafka offset and the stream keeps moving', async () => {
        const client = new FakeAggregator();
        const pipeline = new FirePipeline(client, options());
        await pipeline.restore('c');
        pipeline.ingest({ offset: '0', value: Buffer.from('{"v":1,') });
        pipeline.ingest(messages(new LogBuilder().heartbeat('2026-11-15T06:00:00Z').records)[0]);
        await pipeline.flush('c');
        expect([...client.dlq.keys()]).toEqual(['kafka:0']);
        expect(pipeline.engine.processedOffset).toBe(0);
    });

    it('retries transient Aggregator failures without losing anything', async () => {
        const client = new FakeAggregator();
        client.failures.set('hazards', 3);
        client.failures.set('late', 1);
        await runAll(client, scenario());
        const reference = new FakeAggregator();
        await runAll(reference, scenario());
        expect(client.failures.get('hazards')).toBe(0);
        expect(client.failures.get('late')).toBe(0);
        expect(client.state()).toEqual(reference.state());
        expect([...client.late.keys()]).toEqual([...reference.late.keys()]);
    });

    it('snapshots only after the changes are written, and returns the Kafka offset that is safe to commit', async () => {
        const client = new FakeAggregator();
        const pipeline = new FirePipeline(client, options({ snapshotEveryRecords: 2 }));
        await pipeline.restore('c');
        const [first, second] = messages(scenario());
        pipeline.ingest(first);
        expect(await pipeline.maybeSnapshot('c')).toBeNull();
        pipeline.ingest(second);
        expect(await pipeline.maybeSnapshot('c')).toBe('1');
        const order = client.calls.filter((call) => call !== 'snapshot_get');
        expect(order.lastIndexOf('stats')).toBeLessThan(order.lastIndexOf('snapshot_put'));
        const stored = JSON.parse(gunzipSync(client.snapshot!.body).toString('utf8'));
        expect(stored).toMatchObject({ v: 1, last_offset: 1, last_kafka_offset: '1', allowed_lateness_ms: 120 * 60_000 });
    });

    it.each([1, 2, 4])(
        'P4 #5: a crash at any cut point (snapshot every %i records) ends identical to an uninterrupted run',
        async (every) => {
            const records = scenario();
            const reference = new FakeAggregator();
            const clean = await runAll(reference, records, every);
            for (let cut = 0; cut <= records.length; cut++) {
                const client = new FakeAggregator();
                const crashed = new FirePipeline(client, options({ snapshotEveryRecords: every }));
                await crashed.restore('c');
                for (const message of messages(records).slice(0, cut)) {
                    crashed.ingest(message);
                    if (crashed.unflushedRecords >= 2) await crashed.maybeSnapshot('c');
                }
                // crash: unflushed changes and everything after the last snapshot are lost in memory
                await runAll(client, records, every);
                expect(client.state()).toEqual(reference.state());
                expect([...client.late.keys()]).toEqual([...reference.late.keys()]);
                expect([...client.dlq.keys()]).toEqual([...reference.dlq.keys()]);
                expect(JSON.parse(gunzipSync(client.snapshot!.body).toString('utf8'))).toEqual(
                    JSON.parse(JSON.stringify(clean.engine.snapshot()))
                );
            }
        }
    );

    it('a zombie with an older snapshot is fenced (StaleSnapshotError) and never moves the stored state back', async () => {
        const client = new FakeAggregator();
        await runAll(client, scenario());
        client.snapshot = { ...client.snapshot!, feedOffset: 99 };
        // the zombie never restored the newer state: its engine is at feed offset 0
        const zombie = new FirePipeline(client, options({ snapshotEveryRecords: 1 }));
        zombie.ingest(messages(scenario())[0]);
        await expect(zombie.maybeSnapshot('c', undefined, true)).rejects.toBeInstanceOf(StaleSnapshotError);
        expect(client.snapshot!.feedOffset).toBe(99);
    });

    it('takes allowed_lateness from the snapshot, not from a new configuration (D-25)', async () => {
        const client = new FakeAggregator();
        await runAll(client, scenario());
        const restarted = new FirePipeline(client, options({ allowedLatenessMs: 5 * 60_000 }));
        await restarted.restore('c');
        expect(restarted.engine.allowedLatenessMs).toBe(120 * 60_000);
    });

    it('stop() aborts a retry loop without writing further', async () => {
        const client = new FakeAggregator();
        client.failures.set('stats', 1_000);
        const pipeline: FirePipeline = new FirePipeline(client, options({ sleep: async (): Promise<void> => pipeline.stop() }));
        await pipeline.restore('c');
        pipeline.ingest(messages(scenario())[0]);
        await expect(pipeline.flush('c')).rejects.toBeInstanceOf(PipelineStoppedError);
    });

    it('P4.4: heartbeats after every successful Aggregator call, not only during backoff', async () => {
        const client = new FakeAggregator();
        const pipeline = new FirePipeline(client, options({ snapshotEveryRecords: 1 }));
        await pipeline.restore('c');
        for (const message of messages(scenario()).slice(0, 4)) pipeline.ingest(message);
        const heartbeat = jest.fn(async () => undefined);
        await pipeline.maybeSnapshot('c', heartbeat);
        const calls = client.calls.filter((call) => call !== 'snapshot_get');
        expect(calls).toEqual(expect.arrayContaining(['hazards', 'stats', 'snapshot_put']));
        expect(heartbeat).toHaveBeenCalledTimes(calls.length);
    });

    describe('P4.4 latency metrics count only persisted HazardEvent changes', () => {
        let clock = 0;
        const t0 = Date.parse('2026-11-15T12:00:00.000Z');
        const count = async (histogram: typeof endToEndSeconds) => (await histogram.get()).values.find((v) => v.metricName?.endsWith('_count'))?.value ?? 0;
        const sum = async (histogram: typeof endToEndSeconds) => (await histogram.get()).values.find((v) => v.metricName?.endsWith('_sum'))?.value ?? 0;
        const receivedAt = (records: RawLogRecord[], ms: number[]) =>
            records.map((record, index) => ({ ...record, received_at: new Date(ms[index]).toISOString() }));

        beforeEach(() => {
            endToEndSeconds.reset();
            processingSeconds.reset();
        });

        it('a single detection observes nothing until a second detection turns it into a fire; the wait is included', async () => {
            const client = new FakeAggregator();
            const pipeline = new FirePipeline(client, options({ now: () => clock }));
            await pipeline.restore('c');
            const log = new LogBuilder()
                .heartbeat('2026-11-15T06:00:00Z')
                .detection(at('-2.50000', 500))
                .detection(at('-2.50000', 500))
                .detection(at('-2.50800', 510));
            const [heartbeat, single, duplicate, second] = messages(receivedAt(log.records, [t0, t0, t0 + 1_000, t0 + 60_000]));

            clock = t0 + 2_000;
            for (const message of [heartbeat, single, duplicate]) pipeline.ingest(message);
            await pipeline.flush('c');
            expect(client.hazards.size).toBe(0);
            expect(await count(endToEndSeconds)).toBe(0);
            expect(await count(processingSeconds)).toBe(0);

            clock = t0 + 61_000;
            pipeline.ingest(second);
            await pipeline.flush('c');
            expect(client.hazards.size).toBe(1);
            // both members: 61 s for the waiting single, 1 s for the detection that formed the fire
            expect(await count(endToEndSeconds)).toBe(2);
            expect(await sum(endToEndSeconds)).toBeCloseTo(62);
            expect(await count(processingSeconds)).toBe(1);
            expect(await sum(processingSeconds)).toBeCloseTo(1);
        });

        it('a replayed write the Aggregator reports unchanged observes nothing', async () => {
            const client = new FakeAggregator();
            await runAll(client, scenario());
            endToEndSeconds.reset();
            processingSeconds.reset();
            const replay = new FirePipeline(client, options());
            client.snapshot = null;
            await replay.restore('c');
            for (const message of messages(scenario())) replay.ingest(message);
            await replay.flush('c');
            expect(await count(endToEndSeconds)).toBe(0);
            expect(await count(processingSeconds)).toBe(0);
        });
    });

    it('chunks hazard ops by count and by JSON size', () => {
        const op = (i: number): HazardBatchOp => ({ op: 'delete', source: 'SATELIT', source_ref_id: `fire-${i}`, version: i });
        const ops = Array.from({ length: 7 }, (_, i) => op(i));
        expect(chunkOps(ops, 3, 1_000_000).map((chunk) => chunk.length)).toEqual([3, 3, 1]);
        const size = Buffer.byteLength(JSON.stringify(op(0))) + 1;
        expect(chunkOps(ops, 500, size * 2).map((chunk) => chunk.length)).toEqual([2, 2, 2, 1]);
    });
});
