import { Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, requestParam, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { IHazardEventService } from '../services/hazard-event.service';

@controller('/internal/hazards')
export class HazardEventController {
    constructor(@inject(TYPES.IHazardEventService) private readonly hazardEventService: IHazardEventService) {}

    @httpGet('/')
    async getAllHazards(@response() res: Response) {
        const [hazardEvents, pollingStatus] = await Promise.all([
            this.hazardEventService.getAllHazardEvents(),
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
