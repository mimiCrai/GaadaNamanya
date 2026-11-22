import { injectable } from 'inversify';
import { logger } from '../libs/logger';
import { aggregatorErrorsTotal, aggregatorLatencySeconds } from '../libs/metrics';
import env from '../util/env';

// Aggregator or network unavailable: retry with backoff, never commit
export class TransientAggregatorError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'TransientAggregatorError';
    }
}

// 4xx: the request itself is wrong (a bug); retried too, but counted and logged as permanent
export class PermanentAggregatorError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'PermanentAggregatorError';
    }
}

// another instance stored a newer snapshot: this one is a zombie and must reload
export class StaleSnapshotError extends Error {
    constructor(readonly currentFeedOffset: number | null) {
        super(`snapshot basi: Aggregator sudah menyimpan feed offset ${currentFeedOffset}`);
        this.name = 'StaleSnapshotError';
    }
}

export interface HazardBatchOp {
    op: 'upsert' | 'delete';
    source: 'SATELIT';
    source_ref_id: string;
    version: number;
    hazard?: {
        hazard_type: string;
        severity: string;
        area_name: string;
        latitude: number;
        longitude: number;
        occurred_at: string;
        attributes: Record<string, unknown>;
    };
}

export interface HazardBatchResult {
    op: 'upsert' | 'delete';
    source_ref_id: string;
    hazard_id: string;
    result: 'applied' | 'unchanged' | 'skipped';
}

export interface LateDetectionItem {
    offset: number;
    detection_key: string;
    kind: 'detection' | 'update';
    event_time: string;
    watermark: string;
    received_at: string | null;
}

export interface UnprocessedItem {
    kind: string;
    payload: Buffer;
    sourceRefId: string | null;
    detail: string;
    correlationId: string;
}

export interface StoredSnapshot {
    body: Buffer;
    feedOffset: number;
    kafkaOffset: string | null;
}

export interface IAggregatorClient {
    applyHazards(ops: HazardBatchOp[], correlationId: string): Promise<HazardBatchResult[]>;
    recordLate(items: LateDetectionItem[], correlationId: string): Promise<void>;
    recordUnprocessed(item: UnprocessedItem): Promise<void>;
    putStats(lastOffset: number, stats: Record<string, unknown>, instanceId: string, correlationId: string): Promise<void>;
    putSnapshot(body: Buffer, feedOffset: number, kafkaOffset: string | null, correlationId: string): Promise<void>;
    getSnapshot(correlationId: string): Promise<StoredSnapshot | null>;
}

interface RequestOptions {
    method: string;
    path: string;
    operation: string;
    correlationId: string;
    json?: unknown;
    raw?: { body: Buffer; contentType: string; headers: Record<string, string> };
    accept404?: boolean;
}

/** Usulan 3.4 API: every write of the fire processor goes through the Aggregator (rule 5). */
@injectable()
export class AggregatorClient implements IAggregatorClient {
    async applyHazards(ops: HazardBatchOp[], correlationId: string): Promise<HazardBatchResult[]> {
        const response = await this.request({
            method: 'POST',
            path: '/internal/hazards/batch',
            operation: 'hazards',
            correlationId,
            json: { ops },
        });
        return ((await response!.json()) as { results: HazardBatchResult[] }).results;
    }

    async recordLate(items: LateDetectionItem[], correlationId: string): Promise<void> {
        await this.request({
            method: 'POST',
            path: '/internal/satellite/late-detections',
            operation: 'late',
            correlationId,
            json: { items },
        });
    }

    async recordUnprocessed(item: UnprocessedItem): Promise<void> {
        await this.request({
            method: 'POST',
            path: '/internal/dlq',
            operation: 'dlq',
            correlationId: item.correlationId,
            json: {
                source: 'SATELIT',
                kind: item.kind,
                topic: env.SATELLITE_RAW_TOPIC,
                payload_base64: item.payload.toString('base64'),
                content_type: 'application/json',
                correlation_id: item.correlationId,
                source_ref_id: item.sourceRefId,
                category: 'validation_failed',
                detail: item.detail.slice(0, 2000),
            },
        });
    }

    async putStats(lastOffset: number, stats: Record<string, unknown>, instanceId: string, correlationId: string) {
        await this.request({
            method: 'PUT',
            path: '/internal/fire-processor/stats',
            operation: 'stats',
            correlationId,
            json: { last_offset: lastOffset, instance_id: instanceId, stats },
        });
    }

    async putSnapshot(body: Buffer, feedOffset: number, kafkaOffset: string | null, correlationId: string) {
        try {
            await this.request({
                method: 'PUT',
                path: '/internal/fire-processor/snapshot',
                operation: 'snapshot_put',
                correlationId,
                raw: {
                    body,
                    contentType: 'application/gzip',
                    headers: { 'X-Feed-Offset': String(feedOffset), 'X-Kafka-Offset': kafkaOffset ?? '' },
                },
            });
        } catch (error) {
            if (error instanceof PermanentAggregatorError && error.status === 409) {
                throw new StaleSnapshotError(this.lastConflictOffset);
            }
            throw error;
        }
    }

    async getSnapshot(correlationId: string): Promise<StoredSnapshot | null> {
        const response = await this.request({
            method: 'GET',
            path: '/internal/fire-processor/snapshot',
            operation: 'snapshot_get',
            correlationId,
            accept404: true,
        });
        if (!response) return null;
        const kafkaOffset = response.headers.get('x-kafka-offset');
        return {
            body: Buffer.from(await response.arrayBuffer()),
            feedOffset: Number(response.headers.get('x-feed-offset')),
            kafkaOffset: kafkaOffset ? kafkaOffset : null,
        };
    }

    private lastConflictOffset: number | null = null;

    private async request(options: RequestOptions): Promise<Response | null> {
        const { method, path, operation, correlationId } = options;
        const startedAt = performance.now();
        const done = (outcome: string, status?: number) => {
            const latencyMs = Math.round(performance.now() - startedAt);
            aggregatorLatencySeconds.observe({ operation, outcome }, latencyMs / 1000);
            logger.info({ target: 'bnpb-aggregator', method, path, status, latencyMs, correlationId }, 'Outgoing request completed');
        };
        const headers: Record<string, string> = {
            'X-BNPB-Internal-Key': env.BNPB_INTERNAL_API_KEY,
            'X-Correlation-ID': correlationId,
            ...(options.raw?.headers ?? {}),
        };
        let body: string | Buffer | undefined;
        if (options.json !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(options.json);
        } else if (options.raw) {
            headers['Content-Type'] = options.raw.contentType;
            body = options.raw.body;
        }
        let response: Response;
        try {
            response = await fetch(new URL(path, `${env.BNPB_GATEWAY_BASE_URL}/`), {
                method,
                headers,
                body,
                signal: AbortSignal.timeout(env.BNPB_GATEWAY_TIMEOUT_MS),
            });
        } catch (error) {
            done('network');
            aggregatorErrorsTotal.inc({ operation, kind: 'transient' });
            throw new TransientAggregatorError(`Aggregator tidak terjangkau: ${(error as Error).message}`, { cause: error });
        }
        done(response.ok ? 'ok' : `http_${response.status}`, response.status);
        if (response.ok) return response;
        if (response.status === 404 && options.accept404) return null;
        const text = await response.text().catch(() => '');
        if (response.status >= 500 || [401, 403, 408, 429].includes(response.status)) {
            aggregatorErrorsTotal.inc({ operation, kind: 'transient' });
            throw new TransientAggregatorError(`Aggregator menjawab HTTP ${response.status}`);
        }
        if (response.status === 409) {
            try {
                this.lastConflictOffset = (JSON.parse(text) as { current_feed_offset?: number }).current_feed_offset ?? null;
            } catch {
                this.lastConflictOffset = null;
            }
        }
        aggregatorErrorsTotal.inc({ operation, kind: 'permanent' });
        throw new PermanentAggregatorError(response.status, `Aggregator menolak ${operation} (HTTP ${response.status}): ${text.slice(0, 300)}`);
    }
}
