import { inject, injectable } from 'inversify';
import { hazardEventMessageSchema } from '../contracts/hazard-event-message';
import { TYPES } from '../constants/types';
import { logger } from '../libs/logger';
import { INotificationService } from './notification.service';
import { IMessageSubscriber } from './message-subscriber.service';
import env from '../util/env';

export interface INotificationEventConsumer {
    start(): Promise<void>;
    stop(): Promise<void>;
}

@injectable()
export class NotificationEventConsumer implements INotificationEventConsumer {
    constructor(
        @inject(TYPES.IMessageSubscriber) private readonly subscriber: IMessageSubscriber,
        @inject(TYPES.INotificationService) private readonly notificationService: INotificationService
    ) {}

    async start(): Promise<void> {
        await this.subscriber.subscribe<unknown>({ topic: env.KAFKA_TOPIC }, async (event) => {
            const message = hazardEventMessageSchema.parse(event);
            const result = await this.notificationService.apply(message);
            logger.info(
                {
                    eventId: message.eventId,
                    hazardId: message.hazard.hazardId,
                    severity: message.hazard.severity,
                    result,
                },
                result === 'created' ? 'Created notification inbox entry' : 'Processed notification event'
            );
        });
    }

    async stop(): Promise<void> {
        await this.subscriber.close();
    }
}
