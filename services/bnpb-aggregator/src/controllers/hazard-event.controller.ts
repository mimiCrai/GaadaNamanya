import { Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, queryParam, requestParam, response } from 'inversify-express-utils';
import { z } from 'zod';
import { TYPES } from '../constants/types';
import { HazardSource } from '../db/schema/hazard-events';
import { IHazardEventService } from '../services/hazard-event.service';

@controller('/internal/hazards', TYPES.InternalAuthMiddleware)
export class HazardEventController {
    constructor(@inject(TYPES.IHazardEventService) private readonly hazardEventService: IHazardEventService) {}

    @httpGet('/')
    async getAllHazards(
        @queryParam('since') since: string | undefined,
        @queryParam('source') source: string | undefined,
        @response() res: Response
    ) {
        const parsedSince = since === undefined ? undefined : z.string().datetime({ offset: true }).safeParse(since);
        if (parsedSince && !parsedSince.success) {
            return res.status(400).json({ error: { message: 'since must be an ISO 8601 timestamp' } });
        }

        const parsedSource = source === undefined ? undefined : z.nativeEnum(HazardSource).safeParse(source);
        if (parsedSource && !parsedSource.success) {
            return res.status(400).json({ error: { message: 'source must be BMKG or PVMBG' } });
        }

        const ingestedSince = parsedSince ? new Date(parsedSince.data) : undefined;
        const [hazardEvents, pollingStatus] = await Promise.all([
            this.hazardEventService.getAllHazardEvents(ingestedSince, parsedSource?.data),
            this.hazardEventService.getPollingStatus(),
        ]);
        return res.json({ data: hazardEvents, meta: { pollingStatus } });
    }

    @httpGet('/:hazardId')
    async getHazardById(@requestParam('hazardId') hazardId: string, @response() res: Response) {
        const hazardEvent = await this.hazardEventService.getHazardEventById(hazardId);

        if (!hazardEvent) {
            return res.status(404).json({ error: { message: 'Hazard event not found' } });
        }

        const pollingStatus = await this.hazardEventService.getPollingStatus();
        return res.json({ data: hazardEvent, meta: { pollingStatus } });
    }
}
