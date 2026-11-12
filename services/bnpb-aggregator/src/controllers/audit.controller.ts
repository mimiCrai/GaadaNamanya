import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import { z } from 'zod';
import { TYPES } from '../constants/types';
import { ICanonicalQueryService } from '../services/canonical-query.service';
import { hazardReadQuerySchema } from '../types/canonical-read';

@controller('/internal/audit', TYPES.AuditAuthMiddleware)
export class AuditController {
    constructor(@inject(TYPES.ICanonicalQueryService) private readonly query: ICanonicalQueryService) {}

    @httpGet('/events')
    async events(req: Request, res: Response) {
        const parsed = hazardReadQuerySchema.safeParse(req.query);
        if (!parsed.success)
            return res
                .status(400)
                .json({ error: { code: 'bad_request', message: 'Invalid source, since, limit, or cursor' } });
        return res.json(await this.query.events(parsed.data));
    }

    @httpGet('/checksum')
    async checksum(req: Request, res: Response) {
        const parsed = hazardReadQuerySchema.pick({ source: true }).safeParse(req.query);
        if (!parsed.success) return res.status(400).json({ error: { code: 'bad_request', message: 'Invalid source' } });
        return res.json(await this.query.checksum(parsed.data.source));
    }

    @httpGet('/location')
    async location(req: Request, res: Response) {
        const parsed = z.string().min(1).max(128).safeParse(req.query.hazard_id);
        if (!parsed.success)
            return res.status(400).json({ error: { code: 'bad_request', message: 'hazard_id is required' } });
        const result = await this.query.location(parsed.data);
        return result
            ? res.json(result)
            : res.status(404).json({ error: { code: 'not_found', message: 'Hazard event not found' } });
    }
}
