import { inject, injectable } from 'inversify';
import { hazardEventMessageSchema } from '../contracts/hazard-event-message';
import { TYPES } from '../constants/types';
import { logger } from '../libs/logger';
import { IDashboardProjectionService } from './dashboard-projection.service';
import { IMessageSubscriber } from './message-subscriber.service';
import env from '../util/env';

export interface IDashboardEventConsumer {
    start(): Promise<void>;
    stop(): Promise<void>;
}

@injectable()
export class DashboardEventConsumer implements IDashboardEventConsumer {
    constructor(
        @inject(TYPES.IMessageSubscriber) private readonly subscriber: IMessageSubscriber,
        @inject(TYPES.IDashboardProjectionService)
        private readonly dashboardProjectionService: IDashboardProjectionService
    ) {}

    async start(): Promise<void> {
        await this.subscriber.subscribe<unknown>({ topic: env.KAFKA_TOPIC }, async (event) => {
            const message = hazardEventMessageSchema.parse(event);
            const applied = await this.dashboardProjectionService.apply(message);
            logger.info(
                {
                    eventId: message.eventId,
                    hazardId: message.hazard.hazardId,
                    eventType: message.eventType,
                    applied,
                },
                applied ? 'Updated dashboard projection' : 'Skipped already processed dashboard event'
            );
        });
    }

    async stop(): Promise<void> {
        await this.subscriber.close();
    }
}
