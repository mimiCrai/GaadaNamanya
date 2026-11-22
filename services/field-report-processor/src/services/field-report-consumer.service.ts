import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { inject, injectable } from 'inversify';
import { IAggregatorClient, PermanentStoreError } from '../clients/aggregator.client';
import { TYPES } from '../constants/types';
import { FieldReportMessage, fieldReportMessageSchema } from '../contracts/field-report-message';
import { logger } from '../libs/logger';
import { dlqTotal, duplicateTotal, processedTotal } from '../libs/metrics';
import { KafkaRecord, ProcessOutcome, UnprocessedRecord } from '../types';
import env from '../util/env';
import { IMessageSubscriber } from './message-subscriber.service';

export const FIELD_REPORT_KIND = 'kafka.field-report';

export class ConsumerStoppingError extends Error {
    constructor() {
        super('consumer is stopping; offset not committed');
        this.name = 'ConsumerStoppingError';
    }
}

export interface IFieldReportConsumer {
    start(): Promise<void>;
    stop(): Promise<void>;
    handle(record: KafkaRecord, heartbeat: () => Promise<void>): Promise<ProcessOutcome>;
}

type Decoded = { ok: true; message: FieldReportMessage } | { ok: false; category: UnprocessedRecord['category']; detail: string };

export function decodeRecord(value: Buffer | null): Decoded {
    if (!value || value.length === 0) return { ok: false, category: 'validation_failed', detail: 'pesan kosong' };
    if (value.length > env.FIELD_REPORT_MAX_MESSAGE_BYTES) {
        return {
            ok: false,
            category: 'payload_too_large',
            detail: `ukuran ${value.length} byte melebihi batas ${env.FIELD_REPORT_MAX_MESSAGE_BYTES} byte`,
        };
    }
    if (!isUtf8(value)) return { ok: false, category: 'invalid_utf8', detail: 'byte UTF-8 tidak valid' };
    let json: unknown;
    try {
        json = JSON.parse(value.toString('utf8'));
    } catch (error) {
        return { ok: false, category: 'malformed_json', detail: `JSON tidak valid (${(error as Error).message})` };
    }
    const parsed = fieldReportMessageSchema.safeParse(json);
    if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'pesan'}: ${issue.message}`);
        return { ok: false, category: 'validation_failed', detail: `pesan tidak sesuai kontrak (${detail.slice(0, 3).join('; ')})` };
    }
    return { ok: true, message: parsed.data };
}

export function backoffMs(attempt: number, random: () => number = Math.random): number {
    const ceiling = Math.min(env.FIELD_REPORT_BACKOFF_CAP_MS, env.FIELD_REPORT_BACKOFF_BASE_MS * 2 ** (attempt - 1));
    return Math.round(ceiling * (0.5 + random() * 0.5));
}

/**
 * D-39: finish every record before its offset is committed.
 * Aggregator down → backoff forever without commit (reports wait in Kafka; the receiver keeps answering 202).
 * Poison, rejected N times, or conflict → DLQ in the Aggregator, then commit, so a partition never stalls.
 */
@injectable()
export class FieldReportConsumer implements IFieldReportConsumer {
    private stopping = false;
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    constructor(
        @inject(TYPES.IMessageSubscriber) private readonly subscriber: IMessageSubscriber,
        @inject(TYPES.IAggregatorClient) private readonly aggregator: IAggregatorClient
    ) {}

    async start(): Promise<void> {
        this.stopping = false;
        await this.subscriber.subscribe({ topic: env.KAFKA_TOPIC, fromBeginning: true }, async (record, heartbeat) => {
            await this.handle(record, heartbeat);
        });
    }

    async stop(): Promise<void> {
        this.stopping = true;
        await this.subscriber.close();
    }

    async handle(record: KafkaRecord, heartbeat: () => Promise<void>): Promise<ProcessOutcome> {
        const correlationId = record.headers.correlation_id || randomUUID();
        const sourceRefId = record.headers.report_id || null;
        const decoded = decodeRecord(record.value);
        if (!decoded.ok) {
            return this.toDlq(record, { correlationId, sourceRefId, category: decoded.category, detail: decoded.detail }, heartbeat);
        }
        const { message } = decoded;
        const position = { topic: record.topic, partition: record.partition, offset: record.offset };
        let rejected = 0;
        for (let attempt = 1; ; attempt++) {
            if (this.stopping) throw new ConsumerStoppingError();
            try {
                const write = await this.aggregator.storeFieldReport(message, position, correlationId);
                if (write.result === 'conflict') {
                    const detail = `report_id ${message.report.report_id} sudah ada dengan isi berbeda (sha256 ${write.storedSha256} vs ${write.incomingSha256})`;
                    return this.toDlq(record, { correlationId, sourceRefId: message.report.report_id, category: 'conflict', detail }, heartbeat);
                }
                if (write.result === 'duplicate') duplicateTotal.inc();
                processedTotal.inc({ result: write.result });
                logger.info(
                    { reportId: message.report.report_id, result: write.result, ...position, correlationId },
                    'Field report stored'
                );
                return write.result;
            } catch (error) {
                if (error instanceof PermanentStoreError && ++rejected >= env.FIELD_REPORT_MAX_PERMANENT_ATTEMPTS) {
                    const detail = `percobaan habis setelah ${rejected} kali; galat terakhir: ${error.message}`;
                    return this.toDlq(
                        record,
                        { correlationId, sourceRefId: message.report.report_id, category: 'retry_exhausted', detail },
                        heartbeat
                    );
                }
                logger.warn({ error, reportId: message.report.report_id, attempt, ...position, correlationId }, 'Field report not stored yet; backing off');
                await this.backoff(attempt, heartbeat);
            }
        }
    }

    private async toDlq(
        record: KafkaRecord,
        failure: Pick<UnprocessedRecord, 'correlationId' | 'sourceRefId' | 'category' | 'detail'>,
        heartbeat: () => Promise<void>
    ): Promise<ProcessOutcome> {
        const unprocessed: UnprocessedRecord = {
            ...failure,
            kind: FIELD_REPORT_KIND,
            topic: record.topic,
            payload: record.value ?? Buffer.alloc(0),
        };
        // never commit before the failure is stored: the DLQ itself lives in the Aggregator
        for (let attempt = 1; ; attempt++) {
            if (this.stopping) throw new ConsumerStoppingError();
            try {
                const { messageId } = await this.aggregator.recordUnprocessed(unprocessed);
                dlqTotal.inc({ category: failure.category });
                processedTotal.inc({ result: 'dlq' });
                logger.warn(
                    { messageId, category: failure.category, detail: failure.detail, partition: record.partition, offset: record.offset, correlationId: failure.correlationId },
                    'Field report stored in the DLQ'
                );
                return 'dlq';
            } catch (error) {
                logger.warn({ error, attempt, correlationId: failure.correlationId }, 'DLQ write failed; backing off');
                await this.backoff(attempt, heartbeat);
            }
        }
    }

    // sleeps in slices so the group heartbeat continues and stop() is honoured
    private async backoff(attempt: number, heartbeat: () => Promise<void>): Promise<void> {
        let remaining = backoffMs(attempt);
        while (remaining > 0 && !this.stopping) {
            const slice = Math.min(remaining, 1_000);
            await this.sleep(slice);
            remaining -= slice;
            await heartbeat().catch(() => undefined);
        }
    }
}
