import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import { z } from 'zod';
import { TYPES } from '../constants/types';
import { ISensorPantaiRepository } from '../repositories/sensor-pantai.repository';

@controller('/internal/sensor-pantai', TYPES.AuditAuthMiddleware)
export class SensorPantaiController {
    constructor(@inject(TYPES.ISensorPantaiRepository) private readonly repository: ISensorPantaiRepository) {}

    @httpGet('/status')
    async status(_req: Request, res: Response) {
        const state = await this.repository.getState();
        const { stations, cursor, ...status } = state;
        return res.json({ data: { ...status, stationCount: stations.length } });
    }

    @httpGet('/rejected')
    async rejected(req: Request, res: Response) {
        const limit = z.coerce.number().int().min(1).max(1000).default(100).safeParse(req.query.limit);
        if (!limit.success) return res.status(400).json({ error: { code: 'bad_request', message: 'Invalid limit' } });
        return res.json({ data: await this.repository.getRejected(limit.data) });
    }
}
