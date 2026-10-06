import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, request, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { IReportRepository } from '../repositories/report.repository';
import { parseListQuery, sendList } from './list-query';

@controller('/volcanic-reports', TYPES.OutageMiddleware, TYPES.DataAuthMiddleware, TYPES.DelayMiddleware)
export class VolcanicReportController {
    constructor(@inject(TYPES.IReportRepository) private readonly reports: IReportRepository) {}

    @httpGet('/')
    async list(@request() req: Request, @response() res: Response) {
        const query = parseListQuery(req, res);
        if (!query) return;
        return sendList(req, res, await this.reports.list(query));
    }
}
