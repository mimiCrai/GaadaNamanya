import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { IDashboardProjectionService } from '../services/dashboard-projection.service';

@controller('/api/hazards')
export class DashboardApiController {
    constructor(
        @inject(TYPES.IDashboardProjectionService)
        private readonly dashboardProjectionService: IDashboardProjectionService
    ) {}

    @httpGet('/')
    async getHazards(_req: Request, res: Response) {
        const hazards = await this.dashboardProjectionService.getHazards();
        return res.status(200).json({ data: hazards });
    }
}
