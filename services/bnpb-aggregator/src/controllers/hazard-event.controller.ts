import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, requestParam, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { ICanonicalQueryService } from '../services/canonical-query.service';
import { hazardReadQuerySchema } from '../types/canonical-read';

@controller('/internal/hazards', TYPES.InternalAuthMiddleware)
export class HazardEventController {
    constructor(@inject(TYPES.ICanonicalQueryService) private readonly query: ICanonicalQueryService) {}

    @httpGet('/')
    async getAllHazards(req: Request, res: Response) {
        const parsed = hazardReadQuerySchema.safeParse(req.query);
        if (!parsed.success)
            return res.status(400).json({ error: { message: 'Invalid source, since, limit, or cursor' } });
        return res.json(await this.query.hazards(parsed.data));
    }

    @httpGet('/:hazardId')
    async getHazardById(@requestParam('hazardId') hazardId: string, @response() res: Response) {
        const result = await this.query.hazard(hazardId);
        return result ? res.json(result) : res.status(404).json({ error: { message: 'Hazard event not found' } });
    }
}
