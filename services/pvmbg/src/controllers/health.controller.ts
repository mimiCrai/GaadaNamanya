import { Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { HealthService } from '../services/health.service';

@controller('/health', TYPES.OutageMiddleware)
export class HealthController {
    constructor(@inject(TYPES.HealthService) private readonly healthService: HealthService) {}

    @httpGet('/')
    getHealth(@response() res: Response) {
        return res.status(200).json(this.healthService.check());
    }
}
