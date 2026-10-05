import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, request, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { IEventStore } from '../repositories/event.store';
import { parseListQuery, sendList } from './list-query';

@controller('/seismic-events', TYPES.DataAuthMiddleware, TYPES.DelayMiddleware)
export class SeismicEventController {
    constructor(@inject(TYPES.IEventStore) private readonly store: IEventStore) {}

    @httpGet('/')
    list(@request() req: Request, @response() res: Response) {
        const query = parseListQuery(req, res);
        if (!query) return;
        return sendList(req, res, this.store.listEvents(query));
    }
}
