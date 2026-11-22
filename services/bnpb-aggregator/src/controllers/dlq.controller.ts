import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost, requestParam, response } from 'inversify-express-utils';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { TYPES } from '../constants/types';
import { DLQ_SOURCES } from '../db/schema/unprocessed-messages';
import { IPayloadStore } from '../repositories/payload-store.repository';
import { IUnprocessedQueryService } from '../services/unprocessed-query.service';
import { IUnprocessedReplayService } from '../services/unprocessed-replay.service';
import { PERMANENT_CATEGORIES, ProcessingError, RETRYABLE_CATEGORIES } from '../libs/processing-error';
import { IUnprocessedRecorder } from '../services/unprocessed-recorder.service';

const listQuerySchema = z.object({
    source: z.enum(DLQ_SOURCES).optional(),
    status: z.enum(['retrying', 'parked', 'recovered', 'superseded']).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    cursor: z.string().min(1).max(4096).optional(),
});
const messageIdSchema = z.string().regex(/^msg-[a-f0-9]{24}$/);
const replayBodySchema = z
    .object({
        source: z.enum(DLQ_SOURCES).optional(),
        category: z.enum([...RETRYABLE_CATEGORIES, ...PERMANENT_CATEGORIES]).optional(),
        reason_prefix: z.string().min(1).max(200).optional(),
        status: z.enum(['parked', 'retrying']).default('parked'),
    })
    .strict();
const recordBodySchema = z
    .object({
        source: z.enum(DLQ_SOURCES),
        kind: z.string().min(1).max(64),
        topic: z.string().min(1).max(249).nullable().default(null),
        endpoint: z.string().min(1).max(256).nullable().default(null),
        payload_base64: z.string().max(4 * 1024 * 1024),
        content_type: z.string().min(1).max(128),
        correlation_id: z.string().min(1).max(128),
        source_ref_id: z.string().min(1).max(256).nullable().default(null),
        category: z.enum([...RETRYABLE_CATEGORIES, ...PERMANENT_CATEGORIES]),
        detail: z.string().min(1).max(2000),
    })
    .strict();

@controller('/internal/dlq', TYPES.InternalAuthMiddleware)
export class DlqController {
    constructor(
        @inject(TYPES.IUnprocessedQueryService) private readonly query: IUnprocessedQueryService,
        @inject(TYPES.IPayloadStore) private readonly payloads: IPayloadStore,
        @inject(TYPES.IUnprocessedReplayService) private readonly replays: IUnprocessedReplayService,
        @inject(TYPES.IUnprocessedRecorder) private readonly recorder: IUnprocessedRecorder
    ) {}

    // D-39: components outside the Aggregator (field-report-processor) store failures here; dedup by message_id
    @httpPost('/')
    async record(req: Request, res: Response) {
        const parsed = recordBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) {
            return res.status(400).json({ error: { code: 'bad_request', message: 'Invalid unprocessed message' } });
        }
        const body = parsed.data;
        const result = await this.recorder.record({
            source: body.source,
            context: { kind: body.kind, endpoint: body.endpoint, topic: body.topic },
            payload: { kind: 'inline', bytes: Buffer.from(body.payload_base64, 'base64') },
            contentType: body.content_type,
            correlationId: body.correlation_id,
            sourceRefId: body.source_ref_id,
            error: new ProcessingError(body.category, body.detail),
        });
        return res.status(result.created ? 201 : 200).json({
            message_id: result.messageId,
            created: result.created,
            reopened: result.reopened,
            status: result.status,
        });
    }

    // D-37: requeue for the retry worker; replica-agnostic (only flips status, the leader's worker writes)
    @httpPost('/replay')
    async replay(req: Request, res: Response) {
        const parsed = replayBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) {
            return res.status(400).json({
                error: { code: 'bad_request', message: 'Invalid replay filter (source, category, reason_prefix, status)' },
            });
        }
        const { source, category, reason_prefix: reasonPrefix, status } = parsed.data;
        return res.json(
            await this.replays.replay({ source, category, reasonPrefix, status }, String(res.getHeader('X-Correlation-ID')))
        );
    }

    @httpGet('/')
    async list(req: Request, res: Response) {
        const parsed = listQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return res
                .status(400)
                .json({ error: { code: 'bad_request', message: 'Invalid source, status, limit, or cursor' } });
        }
        return res.json(await this.query.list(parsed.data));
    }

    @httpGet('/:messageId')
    async detail(@requestParam('messageId') messageId: string, @response() res: Response) {
        if (!messageIdSchema.safeParse(messageId).success) return notFound(res);
        const detail = await this.query.detail(messageId);
        return detail ? res.json(detail) : notFound(res);
    }

    @httpGet('/:messageId/raw')
    async raw(@requestParam('messageId') messageId: string, @response() res: Response) {
        if (!messageIdSchema.safeParse(messageId).success) return notFound(res);
        const entry = await this.query.entry(messageId);
        if (!entry) return notFound(res);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(entry.sizeBytes));
        res.setHeader('X-Payload-SHA256', entry.sha256);
        res.setHeader('X-Original-Content-Type', entry.contentType);
        if (entry.payload) return res.end(Buffer.from(entry.payload.buffer));
        if (!entry.payloadRef) return notFound(res);
        await pipeline(this.payloads.openDownload(entry.payloadRef), res);
    }
}

function notFound(res: Response) {
    return res.status(404).json({ error: { code: 'not_found', message: 'Unprocessed message not found' } });
}
