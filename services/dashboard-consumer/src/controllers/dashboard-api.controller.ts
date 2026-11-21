import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import env from '../util/env';
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

    @httpGet('/analytics')
    async getAnalytics(req: Request, res: Response) {
        if (env.CANONICAL_ANALYTICS_URL) {
            const url = new URL(env.CANONICAL_ANALYTICS_URL);
            for (const key of ['from', 'to']) {
                if (typeof req.query[key] === 'string') url.searchParams.set(key, req.query[key] as string);
            }
            try {
                const response = await fetch(url, {
                    headers: { 'X-BNPB-Internal-Key': env.BNPB_INTERNAL_API_KEY ?? '' },
                    signal: AbortSignal.timeout(8000),
                });
                if (response.status === 400) return res.status(400).json(await response.json());
                if (!response.ok) throw new Error('Canonical analytics unavailable');
                return res.json(await response.json());
            } catch {
                return res.status(503).json({
                    error: { code: 'unavailable', message: 'Canonical analytics unavailable' },
                    partial: true,
                    unavailable_units: ['canonical-analytics'],
                    degraded: true,
                });
            }
        }
        const hazards = await this.dashboardProjectionService.getHazards();
        const count = (key: 'source' | 'severity' | 'hazardType') =>
            hazards.reduce<Record<string, number>>((result, hazard) => {
                result[hazard[key]] = (result[hazard[key]] ?? 0) + 1;
                return result;
            }, {});
        const byMonth = hazards.reduce<Record<string, number>>((result, hazard) => {
            const month = hazard.occurredAt.toISOString().slice(0, 7);
            result[month] = (result[month] ?? 0) + 1;
            return result;
        }, {});
        return res.status(200).json({
            partial: true,
            unavailable_units: ['canonical-analytics-not-configured'],
            degraded: true,
            total: hazards.length,
            bySource: count('source'),
            bySeverity: count('severity'),
            byType: count('hazardType'),
            byMonth: Object.fromEntries(Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b))),
        });
    }
}
