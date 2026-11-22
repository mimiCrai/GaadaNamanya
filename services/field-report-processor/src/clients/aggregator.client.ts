import { injectable } from 'inversify';
import { FieldReportMessage } from '../contracts/field-report-message';
import { logger } from '../libs/logger';
import { storeErrorsTotal, storeLatencySeconds } from '../libs/metrics';
import { KafkaPosition, StoreResult, UnprocessedRecord } from '../types';
import env from '../util/env';

// Aggregator or network unavailable: retry with backoff, never commit, never DLQ
export class TransientStoreError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'TransientStoreError';
    }
}

// 4xx (except auth): the message itself is rejected; counted toward the DLQ limit
export class PermanentStoreError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'PermanentStoreError';
    }
}

export interface StoreWrite {
    result: StoreResult;
    storedSha256: string;
    incomingSha256: string;
}

export interface IAggregatorClient {
    storeFieldReport(message: FieldReportMessage, kafka: KafkaPosition, correlationId: string): Promise<StoreWrite>;
    recordUnprocessed(record: UnprocessedRecord): Promise<{ messageId: string }>;
}

/** Field reports reach the Canonical Store only through the Aggregator (rule 5, D-39). */
@injectable()
export class AggregatorClient implements IAggregatorClient {
    async storeFieldReport(message: FieldReportMessage, kafka: KafkaPosition, correlationId: string): Promise<StoreWrite> {
        const path = `/internal/field-reports/${encodeURIComponent(message.report.report_id)}`;
        const body = (await this.request('PUT', path, { message, kafka }, correlationId, 'store')) as {
            result: StoreResult;
            incoming_sha256: string;
            report: { content_sha256: string };
        };
        return { result: body.result, storedSha256: body.report.content_sha256, incomingSha256: body.incoming_sha256 };
    }

    async recordUnprocessed(record: UnprocessedRecord): Promise<{ messageId: string }> {
        const body = (await this.request(
            'POST',
            '/internal/dlq',
            {
                source: 'FIELD_REPORT',
                kind: record.kind,
                topic: record.topic,
                payload_base64: record.payload.toString('base64'),
                content_type: 'application/json',
                correlation_id: record.correlationId,
                source_ref_id: record.sourceRefId,
                category: record.category,
                detail: record.detail,
            },
            record.correlationId,
            'dlq'
        )) as { message_id: string };
        return { messageId: body.message_id };
    }

    private async request(method: string, path: string, body: object, correlationId: string, operation: string): Promise<unknown> {
        const startedAt = performance.now();
        const done = (outcome: string, status?: number) => {
            const latencyMs = Math.round(performance.now() - startedAt);
            storeLatencySeconds.observe({ operation, outcome }, latencyMs / 1000);
            logger.info({ target: 'bnpb-aggregator', method, path, status, latencyMs, correlationId }, 'Outgoing request completed');
        };
        let response: Response;
        try {
            response = await fetch(new URL(path, `${env.BNPB_GATEWAY_BASE_URL}/`), {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'X-BNPB-Internal-Key': env.BNPB_INTERNAL_API_KEY,
                    'X-Correlation-ID': correlationId,
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(env.BNPB_GATEWAY_TIMEOUT_MS),
            });
        } catch (error) {
            done('network');
            storeErrorsTotal.inc({ kind: 'transient' });
            throw new TransientStoreError(`Aggregator tidak terjangkau: ${(error as Error).message}`, { cause: error });
        }
        done(response.ok ? 'ok' : `http_${response.status}`, response.status);
        if (response.ok) return response.json();
        // 401/403 = configuration problem: block (transient) instead of draining every message into the DLQ
        if (response.status >= 500 || [401, 403, 408, 429].includes(response.status)) {
            storeErrorsTotal.inc({ kind: 'transient' });
            throw new TransientStoreError(`Aggregator menjawab HTTP ${response.status}`);
        }
        storeErrorsTotal.inc({ kind: 'permanent' });
        throw new PermanentStoreError(response.status, `Aggregator menolak pesan (HTTP ${response.status})`);
    }
}
