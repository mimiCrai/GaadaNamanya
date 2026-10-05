import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, request, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { IReportStore } from '../repositories/report.store';
import { parseListQuery, sendList } from './list-query';

@controller('/volcanic-reports', TYPES.OutageMiddleware, TYPES.DataAuthMiddleware, TYPES.DelayMiddleware)
export class VolcanicReportController {
    constructor(@inject(TYPES.IReportStore) private readonly store: IReportStore) {}

    @httpGet('/')
    list(@request() req: Request, @response() res: Response) {
        const query = parseListQuery(req, res);
        if (!query) return;
        return sendList(req, res, this.store.list(query));
    }
}
