import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import { z } from 'zod';
import { TYPES } from '../constants/types';
import { HazardSource } from '../db/schema/hazard-events';
import { IUnprocessedQueryService } from '../services/unprocessed-query.service';

export const unprocessedAuditQuerySchema = z.object({
    source: z.nativeEnum(HazardSource).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    cursor: z.string().min(1).max(4096).optional(),
});

@controller('/internal/audit/unprocessed', TYPES.AuditAuthMiddleware)
export class AuditUnprocessedController {
    constructor(@inject(TYPES.IUnprocessedQueryService) private readonly query: IUnprocessedQueryService) {}

    @httpGet('/')
    async unprocessed(req: Request, res: Response) {
        const parsed = unprocessedAuditQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return res
                .status(400)
                .json({ error: { code: 'bad_request', message: 'Invalid source, limit, or cursor' } });
        }
        return res.json(await this.query.audit(parsed.data));
    }
}
