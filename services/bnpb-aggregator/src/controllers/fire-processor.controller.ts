import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost, httpPut, response } from 'inversify-express-utils';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { TYPES } from '../constants/types';
import { HazardSource } from '../db/schema/hazard-events';
import { logger } from '../libs/logger';
import { fireSnapshotBytes, lateDetectionsStoredTotal } from '../libs/metrics';
import { IFireProcessorRepository, SnapshotTooLargeError } from '../repositories/fire-processor.repository';
import env from '../util/env';

const SNAPSHOT_CONTENT_TYPES = ['application/gzip', 'application/octet-stream'];
const offsetHeader = z.string().regex(/^\d{1,16}$/).transform(Number);
const kafkaOffsetHeader = z.string().regex(/^\d{1,20}$/);
const statsBodySchema = z
    .object({
        last_offset: z.number().int().min(-1),
        instance_id: z.string().min(1).max(256).nullable().default(null),
        stats: z.record(z.unknown()),
    })
    .strict();
const isoTime = z.string().datetime({ offset: true });
const lateBodySchema = z
    .object({
        items: z
            .array(
                z
                    .object({
                        offset: z.number().int().min(0),
                        detection_key: z.string().min(1).max(512),
                        kind: z.enum(['detection', 'update']),
                        event_time: isoTime,
                        watermark: isoTime,
                        received_at: isoTime.nullable(),
                    })
                    .strict()
            )
            .min(1)
            .max(5_000),
    })
    .strict();

const badRequest = (res: Response, message: string) => res.status(400).json({ error: { code: 'bad_request', message } });
const correlationOf = (res: Response) => String(res.getHeader('X-Correlation-ID'));

// P4 #5 (CP 3.5): fire processor state lives in the Canonical Store via the Aggregator, never on the pod disk
@controller('/internal/fire-processor', TYPES.InternalAuthMiddleware)
export class FireProcessorController {
    constructor(@inject(TYPES.IFireProcessorRepository) private readonly repository: IFireProcessorRepository) {}

    // raw gzip JSON body streamed to GridFS; X-Feed-Offset guards against an older snapshot overwriting a newer one
    @httpPut('/snapshot')
    async putSnapshot(req: Request, res: Response) {
        const contentType = (req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
        const feedOffset = offsetHeader.safeParse(req.header('x-feed-offset') ?? '');
        const kafkaRaw = req.header('x-kafka-offset');
        const kafkaOffset = kafkaRaw === undefined || kafkaRaw === '' ? null : kafkaOffsetHeader.safeParse(kafkaRaw);
        if (!SNAPSHOT_CONTENT_TYPES.includes(contentType)) return badRequest(res, 'Snapshot must be application/gzip');
        if (!feedOffset.success) return badRequest(res, 'Missing or invalid X-Feed-Offset');
        if (kafkaOffset !== null && !kafkaOffset.success) return badRequest(res, 'Invalid X-Kafka-Offset');
        const meta = { feedOffset: feedOffset.data, kafkaOffset: kafkaOffset?.data ?? null };
        try {
            const saved = await this.repository.saveSnapshot(req, meta, env.FIRE_SNAPSHOT_MAX_BYTES);
            if (!saved.stored) {
                return res.status(409).json({
                    error: { code: 'stale', message: 'A snapshot with a higher feed offset is already stored' },
                    current_feed_offset: saved.current,
                });
            }
            fireSnapshotBytes.set(saved.pointer.sizeBytes);
            logger.info(
                { feedOffset: meta.feedOffset, sizeBytes: saved.pointer.sizeBytes, correlationId: correlationOf(res) },
                'Stored fire processor snapshot'
            );
            return res.json({
                stored: true,
                feed_offset: saved.pointer.feedOffset,
                kafka_offset: saved.pointer.kafkaOffset,
                sha256: saved.pointer.sha256,
                size_bytes: saved.pointer.sizeBytes,
                saved_at: saved.pointer.savedAt.toISOString(),
            });
        } catch (error) {
            if (error instanceof SnapshotTooLargeError) {
                return res.status(413).json({ error: { code: 'payload_too_large', message: error.message } });
            }
            throw error;
        }
    }

    @httpGet('/snapshot')
    async getSnapshot(@response() res: Response) {
        const snapshot = await this.repository.openSnapshot();
        if (!snapshot) return res.status(404).json({ error: { code: 'not_found', message: 'No fire processor snapshot' } });
        const { pointer, stream } = snapshot;
        res.status(200).set({
            'Content-Type': 'application/gzip',
            'Content-Length': String(pointer.sizeBytes),
            'X-Feed-Offset': String(pointer.feedOffset),
            'X-Kafka-Offset': pointer.kafkaOffset ?? '',
            'X-Snapshot-SHA256': pointer.sha256,
        });
        await pipeline(stream, res);
    }

    @httpPut('/stats')
    async putStats(req: Request, res: Response) {
        const parsed = statsBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(res, 'Invalid fire processor stats');
        const stored = await this.repository.putStats(parsed.data.last_offset, parsed.data.stats, parsed.data.instance_id);
        return res.json({ stored });
    }
}

// P4 #2 late detections (separate collection, not unprocessed) and the summary that reports every counter
@controller('/internal/satellite', TYPES.InternalAuthMiddleware)
export class SatelliteSummaryController {
    constructor(@inject(TYPES.IFireProcessorRepository) private readonly repository: IFireProcessorRepository) {}

    @httpPost('/late-detections')
    async late(req: Request, res: Response) {
        const parsed = lateBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) return badRequest(res, 'Invalid late detections');
        const result = await this.repository.recordLate(
            parsed.data.items.map((item) => ({
                offset: item.offset,
                detectionKey: item.detection_key,
                kind: item.kind,
                eventTime: new Date(item.event_time),
                watermark: new Date(item.watermark),
                receivedAt: item.received_at === null ? null : new Date(item.received_at),
            })),
            correlationOf(res)
        );
        lateDetectionsStoredTotal.inc(result.inserted);
        return res.json(result);
    }

    @httpGet('/summary')
    async summary() {
        const [stats, late, hazards, unprocessed] = await Promise.allSettled([
            this.repository.getStats(),
            this.repository.countLate(),
            this.repository.countHazards(HazardSource.Satelit),
            this.repository.countUnprocessed(HazardSource.Satelit),
        ]);
        const value = <T>(result: PromiseSettledResult<T>): T | null =>
            result.status === 'fulfilled' ? result.value : null;
        const processor = value(stats);
        return {
            processor: processor
                ? {
                      ...processor.stats,
                      last_offset: processor.lastOffset,
                      instance_id: processor.instanceId,
                      updated_at: processor.updatedAt.toISOString(),
                  }
                : null,
            late_detections_stored: value(late),
            hazard_events: value(hazards),
            unprocessed: value(unprocessed),
            partial: [stats, late, hazards, unprocessed].some((result) => result.status === 'rejected'),
        };
    }
}
