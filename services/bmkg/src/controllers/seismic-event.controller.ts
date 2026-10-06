import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, request, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { IEventRepository } from '../repositories/event.repository';
import { parseListQuery, sendList } from './list-query';

@controller('/seismic-events', TYPES.DataAuthMiddleware, TYPES.DelayMiddleware)
export class SeismicEventController {
    constructor(@inject(TYPES.IEventRepository) private readonly events: IEventRepository) {}

    @httpGet('/')
    async list(@request() req: Request, @response() res: Response) {
        const query = parseListQuery(req, res);
        if (!query) return;
        return sendList(req, res, await this.events.listEvents(query));
    }
}
