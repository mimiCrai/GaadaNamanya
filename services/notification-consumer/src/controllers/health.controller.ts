import { inject } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import { Request, Response } from 'express';
import { TYPES } from '../constants/types';
import { IHealthService } from '../services/health.service';

@controller('/health')
export class HealthController {
    constructor(@inject(TYPES.IHealthService) private healthService: IHealthService) {}

    @httpGet('/')
    async getHealth(_req: Request, res: Response) {
        const health = await this.healthService.check();
        const statusCode = health.status === 'healthy' ? 200 : 503;
        return res.status(statusCode).json(health);
    }

    @httpGet('/live')
    async getLiveness(_req: Request, res: Response) {
        const result = await this.healthService.liveness();
        return res.status(200).json(result);
    }

    @httpGet('/ready')
    async getReadiness(_req: Request, res: Response) {
        const result = await this.healthService.readiness();
        const statusCode = result.status === 'ok' ? 200 : 503;
        return res.status(statusCode).json(result);
    }
}
