import { inject, injectable } from 'inversify';
import { Admin, ConfigResourceTypes, Kafka, Message, Producer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { TYPES } from '../constants/types';
import { LeaseLostError, LeaseToken } from '../db/schema/background-leases';
import { logger } from '../libs/logger';
import {
    satelliteBatchBytes,
    satelliteBatchChunks,
    satelliteBatchCommitSeconds,
    satelliteCheckpointRecoveredTotal,
} from '../libs/metrics';
import type { SatelliteEventKind } from '../libs/satellite-envelope';
import { IBackgroundLeaseRepository } from '../repositories/background-lease.repository';
import env from '../util/env';

export type SatelliteRecordKind = SatelliteEventKind | 'unprocessed';

export interface SatelliteRawRecord {
    offset: number;
    kind: SatelliteRecordKind;
    receivedAt: string;
    dataRaw?: string;
    virtualNow?: string | null;
    messageId?: string;
    reason?: string;
    correlationId: string;
}

export interface ISatelliteLogWriter {
    prepare(lease: LeaseToken): Promise<void>;
    readCheckpoint(): Promise<number>;
    append(records: SatelliteRawRecord[], lease: LeaseToken): Promise<void>;
    /** Largest encoded record (see encodedMessageBytes) append accepts; larger events must go to the DLQ. */
    maxRecordBytes(): number;
    close(): Promise<void>;
}

export const SATELLITE_RECORD_VERSION = 1;

export function encodeRawRecord(record: SatelliteRawRecord, lease: LeaseToken): Message {
    const value: Record<string, unknown> = {
        v: SATELLITE_RECORD_VERSION,
        offset: record.offset,
        kind: record.kind,
        received_at: record.receivedAt,
    };
    if (record.dataRaw !== undefined) value.data_raw = record.dataRaw;
    if (record.virtualNow) value.virtual_now = record.virtualNow;
    if (record.messageId) value.message_id = record.messageId;
    if (record.reason) value.reason = record.reason;
    return {
        key: String(record.offset),
        value: JSON.stringify(value),
        headers: {
            feed_offset: String(record.offset),
            kind: record.kind,
            fencing_token: String(lease.epoch),
            instance_id: lease.ownerId,
            correlation_id: record.correlationId,
        },
    };
}

/** Kafka's default max.message.bytes (broker message.max.bytes), used when the topic config cannot be read. */
export const KAFKA_DEFAULT_MAX_MESSAGE_BYTES = 1_048_588;
/** Room for the record batch header (61 B) and per-record framing (varints, attributes, header counts). */
export const RECORD_BATCH_OVERHEAD_BYTES = 16 * 1024;
const PER_RECORD_OVERHEAD_BYTES = 64;

function byteSize(value: unknown): number {
    return Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value ?? ''));
}

/** Bytes one encoded record adds to a record batch (uncompressed): key, value, header names/values + framing. */
export function encodedMessageBytes(message: Message): number {
    let bytes = PER_RECORD_OVERHEAD_BYTES + byteSize(message.key) + byteSize(message.value);
    for (const [name, value] of Object.entries(message.headers ?? {}))
        bytes += Buffer.byteLength(name) + byteSize(value);
    return bytes;
}

/** Splits messages, in order, into chunks of at most maxBytes each (a chunk always holds at least one message). */
export function chunkByBytes(messages: Message[], maxBytes: number): Message[][] {
    const chunks: Message[][] = [];
    let current: Message[] = [];
    let currentBytes = 0;
    for (const message of messages) {
        const bytes = encodedMessageBytes(message);
        if (current.length > 0 && currentBytes + bytes > maxBytes) {
            chunks.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(message);
        currentBytes += bytes;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

/** Per-record and per-record-batch budget: the configured value, never above what the topic accepts. */
export function effectiveRecordLimit(configured: number, topicMaxMessageBytes: number): number {
    return Math.max(1_024, Math.min(configured, topicMaxMessageBytes - RECORD_BATCH_OVERHEAD_BYTES));
}

export class SatelliteRecordTooLargeError extends Error {
    constructor(
        readonly offset: number,
        readonly bytes: number,
        readonly limit: number
    ) {
        super(`satellite record at offset ${offset} is ${bytes} bytes encoded, above the ${limit}-byte limit`);
        this.name = 'SatelliteRecordTooLargeError';
    }
}

export function assertConsecutive(records: SatelliteRawRecord[]): void {
    for (let i = 1; i < records.length; i++) {
        if (records[i].offset !== records[i - 1].offset + 1) {
            throw new Error(`satellite batch not consecutive at ${records[i - 1].offset} → ${records[i].offset}`);
        }
    }
}

export class SatelliteContinuityError extends Error {
    constructor(
        readonly expected: number | null,
        readonly received: number
    ) {
        super(
            expected === null
                ? `satellite append at ${received} before the checkpoint was read`
                : `satellite append at ${received}, expected ${expected} (durable checkpoint)`
        );
        this.name = 'SatelliteContinuityError';
    }
}

/** A batch may only start right after the last durable offset, so the checkpoint can never skip a failed batch. */
export function assertContinuesCheckpoint(records: SatelliteRawRecord[], expected: number | null): void {
    if (records.length === 0) return;
    if (expected === null || records[0].offset !== expected) {
        throw new SatelliteContinuityError(expected, records[0].offset);
    }
}

export class TailScanIncompleteError extends Error {
    constructor(start: number, end: number, reachedTo: number | null, timeoutMs: number) {
        super(
            `satellite.raw tail scan [${start}, ${end}) stopped at ${reachedTo ?? 'nothing'} after ${timeoutMs} ms; checkpoint not rebuilt`
        );
        this.name = 'TailScanIncompleteError';
    }
}

/**
 * Backward windows over the physical log [low, end): [end-w, end), [end-2w, end-w), ... down to low.
 * Each window is scanned only if every later one held no committed record (aborted tails can be long).
 */
export function tailScanWindows(low: number, end: number, initial: number): Array<[number, number]> {
    const windows: Array<[number, number]> = [];
    let size = Math.max(1, initial);
    for (let stop = end; stop > low; size *= 2) {
        const start = Math.max(low, stop - size);
        windows.push([start, stop]);
        stop = start;
    }
    return windows;
}

const FENCED_TYPES = new Set(['PRODUCER_FENCED', 'INVALID_PRODUCER_EPOCH', 'INVALID_PRODUCER_ID_MAPPING']);
// 47 INVALID_PRODUCER_EPOCH, 49 INVALID_PRODUCER_ID_MAPPING, 90 PRODUCER_FENCED (unknown to kafkajs 2.2.4 by name).
const FENCED_CODES = new Set([47, 49, 90]);

export function isFencedError(error: unknown): boolean {
    for (let current = error as Record<string, unknown> | undefined, depth = 0; current && depth < 5; depth++) {
        if (typeof current.type === 'string' && FENCED_TYPES.has(current.type)) return true;
        if (typeof current.code === 'number' && FENCED_CODES.has(current.code)) return true;
        current = (current.originalError ?? current.cause) as Record<string, unknown> | undefined;
    }
    return false;
}

// Coordinator still loading / moved (typical right after a broker restart). kafkajs' admin API does not retry these.
const COORDINATOR_TYPES = new Set(['NOT_COORDINATOR', 'COORDINATOR_LOAD_IN_PROGRESS', 'COORDINATOR_NOT_AVAILABLE']);

export function isRetriableKafkaError(error: unknown): boolean {
    for (let current = error as Record<string, unknown> | undefined, depth = 0; current && depth < 5; depth++) {
        if (typeof current.type === 'string' && COORDINATOR_TYPES.has(current.type)) return true;
        if (current.retriable === true) return true;
        current = (current.originalError ?? current.cause) as Record<string, unknown> | undefined;
    }
    return false;
}

export async function withKafkaRetry<T>(work: () => Promise<T>, attempts = 20, delayMs = 500): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await work();
        } catch (error) {
            if (attempt >= attempts || !isRetriableKafkaError(error)) throw error;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}

@injectable()
export class SatelliteLogWriter implements ISatelliteLogWriter {
    private readonly kafka = new Kafka({ clientId: `${env.KAFKA_CLIENT_ID}-satellite`, brokers: env.KAFKA_BROKERS });
    private producer: Producer | null = null;
    private admin: Admin | null = null;
    private epoch: number | undefined;
    /** First backward window of the checkpoint rebuild (doubles per window). Public for tests. */
    tailScanWindow = 1_000;
    tailScanTimeoutMs = 30_000;
    /** Next feed offset the log may receive: set by readCheckpoint and by each commit, cleared by close(). */
    private nextOffset: number | null = null;
    private recordLimit = effectiveRecordLimit(env.SATELLITE_BATCH_MAX_BYTES, KAFKA_DEFAULT_MAX_MESSAGE_BYTES);

    constructor(@inject(TYPES.IBackgroundLeaseRepository) private readonly leases: IBackgroundLeaseRepository) {}

    async prepare(lease: LeaseToken): Promise<void> {
        if (this.producer && this.epoch === lease.epoch) return;
        await this.close();
        try {
            const producer = this.kafka.producer({
                transactionalId: env.KAFKA_SATELLITE_TRANSACTIONAL_ID,
                idempotent: true,
                maxInFlightRequests: 1,
                transactionTimeout: env.BACKGROUND_LEASE_MS,
            });
            await producer.connect();
            this.producer = producer;
            // kafkajs runs InitProducerId lazily on the first transaction(); an empty transaction sends no EndTxn.
            const fence = await producer.transaction();
            await fence.abort();
            const admin = this.kafka.admin();
            await admin.connect();
            this.admin = admin;
            this.recordLimit = effectiveRecordLimit(env.SATELLITE_BATCH_MAX_BYTES, await this.topicMaxMessageBytes());
            this.epoch = lease.epoch;
            logger.info({ epoch: lease.epoch, instanceId: lease.ownerId }, 'Satellite log writer fenced and ready');
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    async readCheckpoint(): Promise<number> {
        // The group offset written by sendOffsets (and the LSO) only becomes visible once the coordinator has
        // written the transaction markers, asynchronously after commit() resolves: a read right after this
        // writer's own commit can still return the previous checkpoint (observed 4 of 30 times on a local broker).
        // Never go below what this producer epoch committed itself. A new epoch starts with InitProducerId,
        // which waits for the previous transaction to complete, so its first read is stable.
        const next = Math.max(await this.readCheckpointFromBroker(), this.nextOffset ?? 0);
        this.nextOffset = next;
        return next;
    }

    private async readCheckpointFromBroker(): Promise<number> {
        const admin = this.requireAdmin();
        const groups = await withKafkaRetry(() =>
            admin.fetchOffsets({ groupId: env.SATELLITE_CHECKPOINT_GROUP, topics: [env.SATELLITE_RAW_TOPIC] })
        );
        const committed = groups.flatMap((group) => group.partitions).find((partition) => partition.partition === 0);
        const next = committed ? Number(committed.offset) : -1;
        if (Number.isSafeInteger(next) && next >= 0) return next;

        // No checkpoint (first run, an aborted first transaction, or expired group offsets): rebuild from the log.
        // prepare() already ran InitProducerId, which aborts a transaction a previous producer left open, so the
        // last stable offset reaches the end of the log and a read_committed scan can finish (review #2).
        // admin.fetchTopicOffsets lists offsets read_committed: `high` is the last stable offset.
        const [partition] = await withKafkaRetry(() => admin.fetchTopicOffsets(env.SATELLITE_RAW_TOPIC));
        const low = Number(partition?.low ?? 0);
        const end = Number(partition?.high ?? 0);
        if (end <= low) return 0;
        const lastOffset = await this.scanCommittedTail(low, end);
        if (lastOffset === null) {
            // Every offset in [low, end) was read and none was committed: the log is logically empty.
            logger.warn({ low, end }, 'satellite.raw holds only aborted records and markers; checkpoint is 0');
            return 0;
        }
        satelliteCheckpointRecoveredTotal.inc();
        logger.warn({ next: lastOffset + 1 }, 'Satellite checkpoint missing; rebuilt from the tail of satellite.raw');
        return lastOffset + 1;
    }

    maxRecordBytes(): number {
        return this.recordLimit;
    }

    async append(records: SatelliteRawRecord[], lease: LeaseToken): Promise<void> {
        if (records.length === 0) return;
        assertConsecutive(records);
        if (this.epoch !== lease.epoch || !this.producer) throw new LeaseLostError();
        assertContinuesCheckpoint(records, this.nextOffset);
        const messages = records.map((record) => encodeRawRecord(record, lease));
        let totalBytes = 0;
        messages.forEach((message, index) => {
            const bytes = encodedMessageBytes(message);
            totalBytes += bytes;
            // The ingest service diverts such events to the DLQ first; sent to Kafka it would fail the same way forever.
            if (bytes > this.recordLimit) {
                throw new SatelliteRecordTooLargeError(records[index].offset, bytes, this.recordLimit);
            }
        });
        // One send = one record batch per partition, and max.message.bytes applies per batch (review #4).
        const chunks = chunkByBytes(messages, this.recordLimit);
        const producer = this.producer;
        const stop = satelliteBatchCommitSeconds.startTimer();
        await this.leases.requireActive(lease);
        const transaction = await producer.transaction();
        try {
            // Sequential sends inside the same transaction: offsets stay in order and the commit stays atomic.
            for (const chunk of chunks) {
                await transaction.send({ topic: env.SATELLITE_RAW_TOPIC, acks: -1, messages: chunk });
            }
            await transaction.sendOffsets({
                consumerGroupId: env.SATELLITE_CHECKPOINT_GROUP,
                topics: [
                    {
                        topic: env.SATELLITE_RAW_TOPIC,
                        partitions: [{ partition: 0, offset: String(records[records.length - 1].offset + 1) }],
                    },
                ],
            });
            await this.leases.requireActive(lease);
            await transaction.commit();
            this.nextOffset = records[records.length - 1].offset + 1;
            stop();
            satelliteBatchBytes.observe(totalBytes);
            satelliteBatchChunks.observe(chunks.length);
        } catch (error) {
            await transaction.abort().catch(() => undefined);
            await this.close();
            if (error instanceof LeaseLostError || isFencedError(error)) throw new LeaseLostError();
            throw error;
        }
    }

    async close(): Promise<void> {
        const producer = this.producer;
        const admin = this.admin;
        this.producer = null;
        this.admin = null;
        this.epoch = undefined;
        this.nextOffset = null;
        await Promise.all([
            producer?.disconnect().catch((error) => logger.warn({ error }, 'Satellite producer disconnect failed')),
            admin?.disconnect().catch(() => undefined),
        ]);
    }

    private async topicMaxMessageBytes(): Promise<number> {
        const topic = env.SATELLITE_RAW_TOPIC;
        try {
            const { resources } = await withKafkaRetry(() =>
                this.requireAdmin().describeConfigs({
                    includeSynonyms: false,
                    resources: [{ type: ConfigResourceTypes.TOPIC, name: topic, configNames: ['max.message.bytes'] }],
                })
            );
            const entry = resources[0]?.configEntries.find((config) => config.configName === 'max.message.bytes');
            const value = Number(entry?.configValue);
            if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`no max.message.bytes for ${topic}`);
            if (env.SATELLITE_BATCH_MAX_BYTES > value - RECORD_BATCH_OVERHEAD_BYTES) {
                logger.warn(
                    { topic, maxMessageBytes: value, configured: env.SATELLITE_BATCH_MAX_BYTES },
                    'SATELLITE_BATCH_MAX_BYTES is above the topic max.message.bytes; using the topic limit'
                );
            }
            return value;
        } catch (error) {
            logger.warn(
                { error, topic },
                'Could not read max.message.bytes of satellite.raw; assuming the Kafka default'
            );
            return KAFKA_DEFAULT_MAX_MESSAGE_BYTES;
        }
    }

    private requireAdmin(): Admin {
        if (!this.admin) throw new Error('Satellite log writer is not prepared');
        return this.admin;
    }

    /**
     * Highest committed feed offset in [low, end), scanning backward windows. Returns null only after the whole
     * range was read to its end; a scan that does not reach the end of its window throws (retry, never guess).
     */
    private async scanCommittedTail(low: number, end: number): Promise<number | null> {
        for (const [start, stop] of tailScanWindows(low, end, this.tailScanWindow)) {
            const found = await this.scanCommittedRange(start, stop);
            if (found !== null) return found;
        }
        return null;
    }

    /** Max feed offset (record key) of the committed records in the physical range [start, stop). */
    private async scanCommittedRange(start: number, stop: number): Promise<number | null> {
        const topic = env.SATELLITE_RAW_TOPIC;
        const consumer = this.kafka.consumer({
            groupId: `${env.SATELLITE_CHECKPOINT_GROUP}-tail-${randomUUID()}`,
            readUncommitted: false,
        });
        let max: number | null = null;
        let reached: number | null = null;
        try {
            await consumer.connect();
            await consumer.subscribe({ topic, fromBeginning: true });
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new TailScanIncompleteError(start, stop, reached, this.tailScanTimeoutMs)),
                    this.tailScanTimeoutMs
                );
                const done = () => {
                    clearTimeout(timer);
                    resolve();
                };
                // Emitted for every fetched batch, also for one that held only aborted records or control markers;
                // lastOffset includes those, so it tells how far the log was read even when nothing is visible.
                consumer.on(consumer.events.END_BATCH_PROCESS, ({ payload }) => {
                    const last = Number(payload.lastOffset);
                    if (payload.partition !== 0 || !Number.isSafeInteger(last)) return;
                    reached = Math.max(reached ?? -1, last);
                    if (reached >= stop - 1) done();
                });
                consumer.on(consumer.events.CRASH, ({ payload }) => {
                    clearTimeout(timer);
                    reject(payload.error);
                });
                consumer
                    .run({
                        autoCommit: false,
                        eachBatch: async ({ batch }) => {
                            for (const message of batch.messages) {
                                const position = Number(message.offset);
                                if (position < start || position >= stop) continue;
                                const offset = Number(message.key?.toString());
                                if (Number.isSafeInteger(offset)) max = Math.max(max ?? -1, offset);
                            }
                        },
                    })
                    // Batches fetched before the seek lands are harmless: positions outside [start, stop) are skipped.
                    .then(() => consumer.seek({ topic, partition: 0, offset: String(start) }), reject);
            });
        } finally {
            await consumer.disconnect().catch(() => undefined);
        }
        return max;
    }
}
