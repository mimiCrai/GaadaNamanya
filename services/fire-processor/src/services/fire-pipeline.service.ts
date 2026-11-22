import { gunzipSync, gzipSync } from 'node:zlib';
import {
    HazardBatchOp,
    IAggregatorClient,
    LateDetectionItem,
    StaleSnapshotError,
    UnprocessedItem,
} from '../clients/aggregator.client';
import { logger } from '../libs/logger';
import {
    allowedLatenessSeconds,
    endToEndSeconds,
    engineGauge,
    flushSeconds,
    hazardWritesTotal,
    lastFeedOffset,
    latenessMismatch,
    recordsTotal,
    snapshotBytes,
    snapshotsTotal,
    virtualNowSeconds,
    watermarkSeconds,
} from '../libs/metrics';
import { EngineSnapshot, FireChange, LateDetection, RawLogRecord, WildfireHazard } from '../types/fire';
import { FireEngine } from './fire-engine.service';

export const UNPROCESSED_KIND = 'kafka.satellite-raw';
const FEED_CHANGE_KINDS = new Set(['detection', 'update', 'retract']);
const LATE_CHUNK = 5_000;

export interface PipelineOptions {
    allowedLatenessMs: number;
    instanceId: string;
    batchMaxOps: number;
    batchMaxBytes: number;
    snapshotEveryRecords: number;
    snapshotIntervalMs: number;
    backoffBaseMs: number;
    backoffCapMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

export interface PipelineMessage {
    offset: string;
    value: Buffer | null;
}

export class PipelineStoppedError extends Error {
    constructor() {
        super('fire pipeline stopping; nothing committed');
        this.name = 'PipelineStoppedError';
    }
}

export function toBatchOp(change: FireChange, hazard: WildfireHazard | null): HazardBatchOp {
    if (change.op === 'delete' || !hazard) {
        return { op: 'delete', source: 'SATELIT', source_ref_id: change.id, version: change.version };
    }
    return {
        op: 'upsert',
        source: 'SATELIT',
        source_ref_id: change.id,
        version: change.version,
        hazard: {
            hazard_type: hazard.hazard_type,
            severity: hazard.severity,
            area_name: hazard.area_name,
            latitude: hazard.latitude,
            longitude: hazard.longitude,
            occurred_at: hazard.occurred_at,
            attributes: { ...hazard.attributes },
        },
    };
}

// chunks within the Aggregator limits (ops per batch and JSON bytes per request body)
export function chunkOps(ops: HazardBatchOp[], maxOps: number, maxBytes: number): HazardBatchOp[][] {
    const chunks: HazardBatchOp[][] = [];
    let current: HazardBatchOp[] = [];
    let bytes = 0;
    for (const op of ops) {
        const size = Buffer.byteLength(JSON.stringify(op)) + 1;
        if (current.length && (current.length >= maxOps || bytes + size > maxBytes)) {
            chunks.push(current);
            current = [];
            bytes = 0;
        }
        current.push(op);
        bytes += size;
    }
    if (current.length) chunks.push(current);
    return chunks;
}

export function backoffMs(attempt: number, baseMs: number, capMs: number, random: () => number = Math.random): number {
    const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
    return Math.round(ceiling * (0.5 + random() * 0.5));
}

// engine + delivery: coalesce per fire, write via the Aggregator, then snapshot; replays are idempotent
export class FirePipeline {
    engine: FireEngine;
    private readonly pending = new Map<string, FireChange>();
    private late: LateDetection[] = [];
    private unprocessed: Omit<UnprocessedItem, 'correlationId'>[] = [];
    private receivedAtMs: number[] = [];
    private unflushed = 0;
    private sinceSnapshot = 0;
    private lastSnapshotAt: number;
    private stopping = false;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    restoredFeedOffset: number | null = null;
    lastSnapshot: { feedOffset: number; kafkaOffset: string | null; bytes: number; at: string } | null = null;

    constructor(
        private readonly client: IAggregatorClient,
        private readonly options: PipelineOptions
    ) {
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.engine = new FireEngine(options.allowedLatenessMs);
        this.lastSnapshotAt = this.now();
        allowedLatenessSeconds.set(options.allowedLatenessMs / 1000);
    }

    get unflushedRecords(): number {
        return this.unflushed;
    }

    stop(): void {
        this.stopping = true;
    }

    // restores the stored snapshot and returns the Kafka offset to seek to (one past the snapshot)
    async restore(correlationId: string, heartbeat: () => Promise<void> = async () => undefined): Promise<string> {
        this.stopping = false;
        this.pending.clear();
        this.late = [];
        this.unprocessed = [];
        this.receivedAtMs = [];
        this.unflushed = 0;
        this.sinceSnapshot = 0;
        this.lastSnapshotAt = this.now();
        const stored = await this.retry('snapshot_get', heartbeat, () => this.client.getSnapshot(correlationId));
        if (!stored) {
            this.engine = new FireEngine(this.options.allowedLatenessMs);
            this.restoredFeedOffset = null;
            latenessMismatch.set(0);
            allowedLatenessSeconds.set(this.options.allowedLatenessMs / 1000);
            logger.info({ correlationId }, 'No fire snapshot stored; processing satellite.raw from the beginning');
            return '0';
        }
        const snapshot = JSON.parse(gunzipSync(stored.body).toString('utf8')) as EngineSnapshot;
        const { engine, latenessMismatch: mismatch } = FireEngine.restore(snapshot, {
            configuredAllowedLatenessMs: this.options.allowedLatenessMs,
        });
        this.engine = engine;
        this.restoredFeedOffset = snapshot.last_offset;
        latenessMismatch.set(mismatch ? 1 : 0);
        allowedLatenessSeconds.set(engine.allowedLatenessMs / 1000);
        if (mismatch) {
            logger.warn(
                { configured: this.options.allowedLatenessMs, snapshot: engine.allowedLatenessMs, correlationId },
                'Configured allowed lateness differs from the snapshot; the snapshot value is used (D-25)'
            );
        }
        this.updateGauges();
        const seek = snapshot.last_kafka_offset === null ? '0' : (BigInt(snapshot.last_kafka_offset) + 1n).toString();
        logger.info(
            { feedOffset: snapshot.last_offset, kafkaOffset: snapshot.last_kafka_offset, seek, correlationId },
            'Restored fire processor snapshot'
        );
        return seek;
    }

    ingest(message: PipelineMessage): void {
        const text = message.value?.toString('utf8') ?? '';
        let record: RawLogRecord = {};
        let parsed = true;
        try {
            const value: unknown = JSON.parse(text);
            if (value && typeof value === 'object' && !Array.isArray(value)) record = value as RawLogRecord;
            else parsed = false;
        } catch {
            parsed = false;
        }
        const result = this.engine.process(record, message.offset);
        recordsTotal.inc({ outcome: result.outcome });
        if (!parsed || result.outcome === 'invalid') {
            this.unprocessed.push({
                kind: UNPROCESSED_KIND,
                payload: message.value ?? Buffer.alloc(0),
                sourceRefId: result.offset === null ? `kafka:${message.offset}` : `offset:${result.offset}`,
                detail: parsed ? (result.invalidReason ?? 'record tidak valid') : 'record satellite.raw bukan objek JSON',
            });
        }
        if (result.late) this.late.push(result.late);
        for (const change of result.changes) this.pending.set(change.id, change);
        if (result.outcome !== 'stale_offset' && FEED_CHANGE_KINDS.has(String(record.kind))) {
            const receivedAt = typeof record.received_at === 'string' ? Date.parse(record.received_at) : NaN;
            if (Number.isFinite(receivedAt)) this.receivedAtMs.push(receivedAt);
        }
        this.unflushed++;
        if (result.outcome !== 'stale_offset') this.sinceSnapshot++;
    }

    // DLQ, late detections, HazardEvents, then stats; each step retried until it succeeds
    async flush(correlationId: string, heartbeat: () => Promise<void> = async () => undefined): Promise<void> {
        if (this.unflushed === 0) return;
        const startedAt = this.now();
        for (const item of this.unprocessed) {
            await this.retry('dlq', heartbeat, () => this.client.recordUnprocessed({ ...item, correlationId }));
        }
        for (let index = 0; index < this.late.length; index += LATE_CHUNK) {
            const items = this.late.slice(index, index + LATE_CHUNK).map(toLateItem);
            await this.retry('late', heartbeat, () => this.client.recordLate(items, correlationId));
        }
        const changes = [...this.pending.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const ops = changes.map((change) => toBatchOp(change, change.op === 'upsert' ? this.engine.hazard(change.id) : null));
        for (const chunk of chunkOps(ops, this.options.batchMaxOps, this.options.batchMaxBytes)) {
            const results = await this.retry('hazards', heartbeat, () => this.client.applyHazards(chunk, correlationId));
            for (const result of results) hazardWritesTotal.inc({ op: result.op, result: result.result });
        }
        const storedAt = this.now();
        for (const receivedAt of this.receivedAtMs) endToEndSeconds.observe(Math.max(0, storedAt - receivedAt) / 1000);
        await this.retry('stats', heartbeat, () =>
            this.client.putStats(this.engine.processedOffset, this.stats(), this.options.instanceId, correlationId)
        );
        logger.info(
            {
                records: this.unflushed,
                hazardOps: ops.length,
                late: this.late.length,
                unprocessed: this.unprocessed.length,
                feedOffset: this.engine.processedOffset,
                correlationId,
            },
            'Flushed fire changes'
        );
        this.pending.clear();
        this.late = [];
        this.unprocessed = [];
        this.receivedAtMs = [];
        this.unflushed = 0;
        this.updateGauges();
        flushSeconds.observe((this.now() - startedAt) / 1000);
    }

    // after a flush: persist the state when due; returns the Kafka offset now safe to commit, or null
    async maybeSnapshot(
        correlationId: string,
        heartbeat: () => Promise<void> = async () => undefined,
        force = false
    ): Promise<string | null> {
        if (this.unflushed > 0) await this.flush(correlationId, heartbeat);
        const due =
            force ||
            this.sinceSnapshot >= this.options.snapshotEveryRecords ||
            this.now() - this.lastSnapshotAt >= this.options.snapshotIntervalMs;
        if (!due || this.sinceSnapshot === 0 || this.engine.processedOffset < 0) return null;
        const feedOffset = this.engine.processedOffset;
        const kafkaOffset = this.engine.kafkaOffset;
        const body = gzipSync(Buffer.from(JSON.stringify(this.engine.snapshot())));
        try {
            await this.retry('snapshot_put', heartbeat, () =>
                this.client.putSnapshot(body, feedOffset, kafkaOffset, correlationId)
            );
        } catch (error) {
            if (error instanceof StaleSnapshotError) snapshotsTotal.inc({ outcome: 'stale' });
            throw error;
        }
        snapshotsTotal.inc({ outcome: 'stored' });
        snapshotBytes.set(body.length);
        this.sinceSnapshot = 0;
        this.lastSnapshotAt = this.now();
        this.lastSnapshot = { feedOffset, kafkaOffset, bytes: body.length, at: new Date(this.lastSnapshotAt).toISOString() };
        logger.info({ feedOffset, kafkaOffset, bytes: body.length, correlationId }, 'Stored fire snapshot');
        return kafkaOffset;
    }

    stats(): Record<string, unknown> {
        return {
            ...this.engine.stats(),
            restored_from_feed_offset: this.restoredFeedOffset,
            last_snapshot: this.lastSnapshot,
            instance_id: this.options.instanceId,
        };
    }

    private updateGauges(): void {
        const stats = this.engine.stats();
        lastFeedOffset.set(this.engine.processedOffset);
        if (Number.isFinite(this.engine.watermark)) watermarkSeconds.set(this.engine.watermark / 1000);
        if (this.engine.virtualNow !== null) virtualNowSeconds.set(this.engine.virtualNow / 1000);
        for (const counter of ['fires', 'final_fires', 'active', 'single_detections', 'low_excluded', 'retracted'] as const) {
            engineGauge.set({ counter }, stats[counter]);
        }
        engineGauge.set({ counter: 'late_detections' }, stats.late_detections);
    }

    private async retry<T>(operation: string, heartbeat: () => Promise<void>, work: () => Promise<T>): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            if (this.stopping) throw new PipelineStoppedError();
            try {
                return await work();
            } catch (error) {
                if (error instanceof StaleSnapshotError) throw error;
                logger.warn({ error, operation, attempt }, 'Aggregator call failed; backing off');
                let remaining = backoffMs(attempt, this.options.backoffBaseMs, this.options.backoffCapMs);
                while (remaining > 0 && !this.stopping) {
                    const slice = Math.min(remaining, 1_000);
                    await this.sleep(slice);
                    remaining -= slice;
                    await heartbeat().catch(() => undefined);
                }
            }
        }
    }
}

const toLateItem = (late: LateDetection): LateDetectionItem => ({
    offset: late.offset,
    detection_key: late.detection_key,
    kind: late.kind,
    event_time: late.event_time,
    watermark: late.watermark,
    received_at: isoOrNull(late.received_at),
});

function isoOrNull(text: string | null): string | null {
    const ms = text === null ? NaN : Date.parse(text);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
