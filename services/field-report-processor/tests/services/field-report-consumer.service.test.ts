import 'reflect-metadata';
import { createHash } from 'node:crypto';
import {
    IAggregatorClient,
    PermanentStoreError,
    StoreWrite,
    TransientStoreError,
} from '../../src/clients/aggregator.client';
import { FieldReportMessage } from '../../src/contracts/field-report-message';
import {
    ConsumerStoppingError,
    decodeRecord,
    FieldReportConsumer,
} from '../../src/services/field-report-consumer.service';
import { IMessageSubscriber, MessageHandler } from '../../src/services/message-subscriber.service';
import { KafkaPosition, KafkaRecord, UnprocessedRecord } from '../../src/types';

const message = (id: string, description = 'Awan panas guguran'): FieldReportMessage => ({
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
    reporter: { sub: 'u-1', role: 'lapangan' },
    accepted_at: new Date().toISOString(),
});
const ID_A = '6b0f8c44-1f43-4a54-9d55-2f1a3c9e7b10';
const ID_B = '0d3c2b1a-9f8e-4d7c-8b6a-5f4e3d2c1b0a';
const sha = (m: FieldReportMessage) => createHash('sha256').update(JSON.stringify([m.report, m.reporter.sub])).digest('hex');

/** Same semantics as the Aggregator: insert by report_id, first write wins, failures injectable. */
class FakeAggregator implements IAggregatorClient {
    readonly docs = new Map<string, { sha: string; deliveries: number; kafka: KafkaPosition }>();
    readonly dlq = new Map<string, UnprocessedRecord>();
    storeFailures: Error[] = [];
    dlqFailures: Error[] = [];

    async storeFieldReport(m: FieldReportMessage, kafka: KafkaPosition): Promise<StoreWrite> {
        const failure = this.storeFailures.shift();
        if (failure) throw failure;
        const incoming = sha(m);
        const stored = this.docs.get(m.report.report_id);
        if (!stored) {
            this.docs.set(m.report.report_id, { sha: incoming, deliveries: 1, kafka });
            return { result: 'created', storedSha256: incoming, incomingSha256: incoming };
        }
        stored.deliveries++;
        return { result: stored.sha === incoming ? 'duplicate' : 'conflict', storedSha256: stored.sha, incomingSha256: incoming };
    }

    async recordUnprocessed(record: UnprocessedRecord) {
        const failure = this.dlqFailures.shift();
        if (failure) throw failure;
        const id = `msg-${createHash('sha256').update(record.payload).digest('hex').slice(0, 24)}`;
        this.dlq.set(id, record);
        return { messageId: id };
    }
}

/** One partition, commit after the handler (like MessageSubscriber); crash = stop before commit. */
class FakePartition implements IMessageSubscriber {
    readonly log: KafkaRecord[] = [];
    committed = 0;
    heartbeats = 0;
    private handler?: MessageHandler;
    async connect() {}
    async subscribe(_options: unknown, handler: MessageHandler) {
        this.handler = handler;
    }
    isRunning() {
        return true;
    }
    async close() {}
    append(value: Buffer | null, reportId?: string) {
        this.log.push({
            topic: 'field-reports',
            partition: 0,
            offset: String(this.log.length),
            value,
            headers: { correlation_id: `c-${this.log.length}`, ...(reportId ? { report_id: reportId } : {}) },
        });
    }
    // deliver from the committed offset; crashAfterHandle = process the record but die before the commit
    async drain(options: { crashAfterHandle?: number } = {}) {
        while (this.committed < this.log.length) {
            const record = this.log[this.committed];
            await this.handler!(record, async () => void this.heartbeats++);
            if (options.crashAfterHandle === Number(record.offset)) return;
            this.committed++;
        }
    }
}

describe('FieldReportConsumer (D-39)', () => {
    let store: FakeAggregator;
    let partition: FakePartition;
    let consumer: FieldReportConsumer;
    const json = (m: unknown) => Buffer.from(JSON.stringify(m));

    beforeEach(async () => {
        store = new FakeAggregator();
        partition = new FakePartition();
        consumer = new FieldReportConsumer(partition, store);
        consumer.sleep = async () => undefined;
        await consumer.start();
    });

    it('the same report delivered twice (client resend) ends as one document', async () => {
        partition.append(json(message(ID_A)), ID_A);
        partition.append(json({ ...message(ID_A), accepted_at: new Date(Date.now() + 1_000).toISOString() }), ID_A);
        await partition.drain();
        expect(store.docs.size).toBe(1);
        expect(store.docs.get(ID_A)!.deliveries).toBe(2);
        expect(partition.committed).toBe(2);
        expect(store.dlq.size).toBe(0);
    });

    it('a crash after the write but before the commit redelivers the record and still leaves one document', async () => {
        partition.append(json(message(ID_A)), ID_A);
        await partition.drain({ crashAfterHandle: 0 });
        expect(partition.committed).toBe(0);
        const restarted = new FieldReportConsumer(partition, store);
        restarted.sleep = async () => undefined;
        await restarted.start();
        await partition.drain();
        expect(store.docs.size).toBe(1);
        expect(store.docs.get(ID_A)!.deliveries).toBe(2);
        expect(partition.committed).toBe(1);
    });

    it('a poison record goes to the DLQ with its exact bytes and the partition keeps moving', async () => {
        partition.append(Buffer.from('{"v":1,"report":{"report_id"'), ID_A);
        partition.append(Buffer.from([0xc3, 0x28]));
        partition.append(json({ v: 2 }));
        partition.append(json(message(ID_B)), ID_B);
        await partition.drain();
        const categories = [...store.dlq.values()].map((r) => r.category);
        expect(categories).toEqual(['malformed_json', 'invalid_utf8', 'validation_failed']);
        expect([...store.dlq.values()][0].payload.toString()).toBe('{"v":1,"report":{"report_id"');
        expect([...store.dlq.values()][0].sourceRefId).toBe(ID_A);
        expect(store.docs.has(ID_B)).toBe(true);
        expect(partition.committed).toBe(4);
    });

    it('while the Aggregator is down it backs off with heartbeats, never commits early and never uses the DLQ', async () => {
        store.storeFailures = Array.from({ length: 6 }, () => new TransientStoreError('ECONNREFUSED'));
        partition.append(json(message(ID_A)), ID_A);
        await partition.drain();
        expect(store.docs.has(ID_A)).toBe(true);
        expect(store.dlq.size).toBe(0);
        expect(partition.heartbeats).toBeGreaterThanOrEqual(6);
    });

    it('a record the Aggregator rejects N times is parked in the DLQ (retry_exhausted)', async () => {
        store.storeFailures = Array.from({ length: 3 }, () => new PermanentStoreError(400, 'Aggregator menolak pesan (HTTP 400)'));
        partition.append(json(message(ID_A)), ID_A);
        await partition.drain();
        const [entry] = [...store.dlq.values()];
        expect(entry.category).toBe('retry_exhausted');
        expect(entry.detail).toBe('percobaan habis setelah 3 kali; galat terakhir: Aggregator menolak pesan (HTTP 400)');
        expect(partition.committed).toBe(1);
    });

    it('same report_id with different content: first wins, the second is parked as conflict', async () => {
        partition.append(json(message(ID_A)), ID_A);
        partition.append(json(message(ID_A, 'isi lain')), ID_A);
        await partition.drain();
        const first = message(ID_A);
        const [entry] = [...store.dlq.values()];
        expect(entry.category).toBe('conflict');
        expect(entry.detail).toBe(
            `report_id ${ID_A} sudah ada dengan isi berbeda (sha256 ${sha(first)} vs ${sha(message(ID_A, 'isi lain'))})`
        );
        expect(store.docs.get(ID_A)!.sha).toBe(sha(first));
    });

    it('does not commit when the DLQ write itself fails until it succeeds', async () => {
        store.dlqFailures = [new TransientStoreError('down'), new TransientStoreError('down')];
        partition.append(Buffer.from('not json'));
        await partition.drain();
        expect(store.dlq.size).toBe(1);
        expect(partition.committed).toBe(1);
    });

    it('stop() aborts a backoff without committing', async () => {
        store.storeFailures = Array.from({ length: 1_000 }, () => new TransientStoreError('down'));
        partition.append(json(message(ID_A)), ID_A);
        consumer.sleep = async () => {
            await consumer.stop();
        };
        await expect(partition.drain()).rejects.toBeInstanceOf(ConsumerStoppingError);
        expect(partition.committed).toBe(0);
    });
});

describe('decodeRecord', () => {
    it.each([
        [null, 'validation_failed'],
        [Buffer.alloc(70 * 1024, 0x20), 'payload_too_large'],
        [Buffer.from([0xff]), 'invalid_utf8'],
        [Buffer.from('{'), 'malformed_json'],
    ])('classifies %#', (value, category) => {
        expect(decodeRecord(value as Buffer | null)).toEqual(expect.objectContaining({ ok: false, category }));
    });
});
