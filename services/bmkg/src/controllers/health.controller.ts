import { Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { HealthService } from '../services/health.service';

@controller('/health')
export class HealthController {
    constructor(@inject(TYPES.HealthService) private readonly healthService: HealthService) {}

    @httpGet('/')
    async getHealth(@response() res: Response) {
        const health = await this.healthService.check();
        return res.status(health.status === 'ok' ? 200 : 503).json(health);
    }
}
