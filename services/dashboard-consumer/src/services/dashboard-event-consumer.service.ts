import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { logger } from '../libs/logger';
import { MessageSubscriber } from './message-subscriber.service';
import env from '../util/env';

@injectable()
export class DashboardEventConsumer {
    constructor(@inject(TYPES.MessageSubscriber) private readonly subscriber: MessageSubscriber) {}

    async start(): Promise<void> {
        await this.subscriber.subscribe<Record<string, unknown>>({ topic: env.KAFKA_TOPIC }, async (event) => {
            // The dashboard projection will be implemented here. Keep this handler idempotent:
            // Kafka can redeliver an event if the process stops before its offset is committed.
            logger.info({ event }, 'Received hazard event for dashboard');
        });
    }

    async stop(): Promise<void> {
        await this.subscriber.close();
    }
}
