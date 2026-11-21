import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, request, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { deepNestingBody, invalidUtf8Body, sendBytes, streamOversized, truncatedBody } from '../libs/malformed';
import { IReportRepository } from '../repositories/report.repository';
import { MalformedService } from '../services/malformed.service';
import { listEnvelope, parseListQuery, sendList } from './list-query';

@controller('/volcanic-reports', TYPES.OutageMiddleware, TYPES.DataAuthMiddleware, TYPES.DelayMiddleware)
export class VolcanicReportController {
    constructor(
        @inject(TYPES.IReportRepository) private readonly reports: IReportRepository,
        @inject(TYPES.MalformedService) private readonly malformed: MalformedService
    ) {}

    @httpGet('/')
    async list(@request() req: Request, @response() res: Response) {
        const query = parseListQuery(req, res);
        if (!query) return;
        const data = await this.reports.listWire(query);
        const injection = this.malformed.take();
        if (!injection) return sendList(req, res, data);

        // P3 #3: corrupt this one response, built from the real data
        res.setHeader('X-PVMBG-Malformed', injection.kind);
        const envelope = listEnvelope(req, data);
        switch (injection.kind) {
            case 'truncated':
                return sendBytes(res, truncatedBody(envelope));
            case 'deep_nesting':
                return sendBytes(res, deepNestingBody());
            case 'invalid_utf8':
                return sendBytes(res, invalidUtf8Body(envelope));
            case 'oversized':
                return streamOversized(res, envelope, injection.bytes);
        }
    }
}
