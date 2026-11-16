import { inject, injectable } from 'inversify';
import { Admin, Kafka, Message, Producer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { TYPES } from '../constants/types';
import { LeaseLostError, LeaseToken } from '../db/schema/background-leases';
import { logger } from '../libs/logger';
import { satelliteBatchCommitSeconds, satelliteCheckpointRecoveredTotal } from '../libs/metrics';
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

export function assertConsecutive(records: SatelliteRawRecord[]): void {
    for (let i = 1; i < records.length; i++) {
        if (records[i].offset !== records[i - 1].offset + 1) {
            throw new Error(`satellite batch not consecutive at ${records[i - 1].offset} → ${records[i].offset}`);
        }
    }
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
            this.epoch = lease.epoch;
            logger.info({ epoch: lease.epoch, instanceId: lease.ownerId }, 'Satellite log writer fenced and ready');
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    async readCheckpoint(): Promise<number> {
        const admin = this.requireAdmin();
        const groups = await withKafkaRetry(() =>
            admin.fetchOffsets({ groupId: env.SATELLITE_CHECKPOINT_GROUP, topics: [env.SATELLITE_RAW_TOPIC] })
        );
        const committed = groups.flatMap((group) => group.partitions).find((partition) => partition.partition === 0);
        const next = committed ? Number(committed.offset) : -1;
        if (Number.isSafeInteger(next) && next >= 0) return next;

        // No checkpoint. Starting from 0 is only correct for an empty topic; otherwise rebuild from the log tail.
        const [partition] = await withKafkaRetry(() => admin.fetchTopicOffsets(env.SATELLITE_RAW_TOPIC));
        if (!partition || Number(partition.high) <= Number(partition.low)) return 0;
        const lastOffset = await this.tailRead();
        if (lastOffset === null) {
            throw new Error(
                'satellite.raw is not empty but no committed record could be read; refusing to restart at 0'
            );
        }
        satelliteCheckpointRecoveredTotal.inc();
        logger.warn({ next: lastOffset + 1 }, 'Satellite checkpoint missing; rebuilt from the tail of satellite.raw');
        return lastOffset + 1;
    }

    async append(records: SatelliteRawRecord[], lease: LeaseToken): Promise<void> {
        if (records.length === 0) return;
        assertConsecutive(records);
        if (this.epoch !== lease.epoch || !this.producer) throw new LeaseLostError();
        const producer = this.producer;
        const stop = satelliteBatchCommitSeconds.startTimer();
        await this.leases.requireActive(lease);
        const transaction = await producer.transaction();
        try {
            await transaction.send({
                topic: env.SATELLITE_RAW_TOPIC,
                acks: -1,
                messages: records.map((record) => encodeRawRecord(record, lease)),
            });
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
            stop();
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
        await Promise.all([
            producer?.disconnect().catch((error) => logger.warn({ error }, 'Satellite producer disconnect failed')),
            admin?.disconnect().catch(() => undefined),
        ]);
    }

    private requireAdmin(): Admin {
        if (!this.admin) throw new Error('Satellite log writer is not prepared');
        return this.admin;
    }

    private async tailRead(): Promise<number | null> {
        const admin = this.requireAdmin();
        const [partition] = await admin.fetchTopicOffsets(env.SATELLITE_RAW_TOPIC);
        const high = Number(partition?.high ?? 0);
        const consumer = this.kafka.consumer({
            groupId: `${env.SATELLITE_CHECKPOINT_GROUP}-tail-${randomUUID()}`,
            readUncommitted: false,
        });
        let max: number | null = null;
        try {
            await consumer.connect();
            await consumer.subscribe({ topic: env.SATELLITE_RAW_TOPIC, fromBeginning: true });
            await new Promise<void>((resolve) => {
                const deadline = setTimeout(resolve, 30_000);
                let idle = setTimeout(resolve, 10_000);
                const finish = () => {
                    clearTimeout(deadline);
                    clearTimeout(idle);
                    resolve();
                };
                void consumer.run({
                    autoCommit: false,
                    eachBatch: async ({ batch }) => {
                        for (const message of batch.messages) {
                            const offset = Number(message.key?.toString());
                            if (Number.isSafeInteger(offset)) max = Math.max(max ?? -1, offset);
                            if (Number(message.offset) >= high - 1) return finish();
                        }
                        clearTimeout(idle);
                        idle = setTimeout(finish, 3_000);
                    },
                });
            });
        } finally {
            await consumer.disconnect().catch(() => undefined);
        }
        return max;
    }
}
