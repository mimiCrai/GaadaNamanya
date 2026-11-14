import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, requestParam, response } from 'inversify-express-utils';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { TYPES } from '../constants/types';
import { HazardSource } from '../db/schema/hazard-events';
import { IPayloadStore } from '../repositories/payload-store.repository';
import { IUnprocessedQueryService } from '../services/unprocessed-query.service';

const listQuerySchema = z.object({
    source: z.nativeEnum(HazardSource).optional(),
    status: z.enum(['retrying', 'parked', 'recovered']).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    cursor: z.string().min(1).max(4096).optional(),
});
const messageIdSchema = z.string().regex(/^msg-[a-f0-9]{24}$/);

@controller('/internal/dlq', TYPES.InternalAuthMiddleware)
export class DlqController {
    constructor(
        @inject(TYPES.IUnprocessedQueryService) private readonly query: IUnprocessedQueryService,
        @inject(TYPES.IPayloadStore) private readonly payloads: IPayloadStore
    ) {}

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
