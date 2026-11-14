import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { logger } from '../libs/logger';
import { IOutboxEventRepository } from '../repositories/outbox-event.repository';
import env from '../util/env';
import { IMessagePublisher } from './message-publisher.service';
import { IBackgroundLeadershipService } from './background-leadership.service';
import { IBackgroundLeaseRepository } from '../repositories/background-lease.repository';
import { LeaseLostError } from '../db/schema/background-leases';

export interface IOutboxRelayService {
    start(): void;
    stop(): void;
}

@injectable()
export class OutboxRelayService implements IOutboxRelayService {
    private timer: NodeJS.Timeout | undefined;
    private running = false;
    private stopped = true;

    constructor(
        @inject(TYPES.IOutboxEventRepository) private readonly outboxEventRepository: IOutboxEventRepository,
        @inject(TYPES.IMessagePublisher) private readonly messagePublisher: IMessagePublisher,
        @inject(TYPES.IBackgroundLeadershipService) private readonly leadership: IBackgroundLeadershipService,
        @inject(TYPES.IBackgroundLeaseRepository) private readonly leases: IBackgroundLeaseRepository
    ) {}

    start(): void {
        if (!this.stopped) {
            return;
        }

        this.stopped = false;
        this.schedule(0);
        logger.info('Outbox relay started');
    }

    stop(): void {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        logger.info('Outbox relay stopped');
    }

    private schedule(delayMs: number): void {
        this.timer = setTimeout(() => {
            void this.runAndSchedule();
        }, delayMs);
    }

    private async runAndSchedule(): Promise<void> {
        this.timer = undefined;
        if (this.stopped) {
            return;
        }
        if (this.running) {
            this.schedule(env.OUTBOX_RELAY_INTERVAL_MS);
            return;
        }

        this.running = true;
        try {
            await this.publishBatch();
        } catch (error) {
            logger.error({ error }, 'Outbox relay batch failed unexpectedly');
        } finally {
            this.running = false;
            if (!this.stopped) {
                this.schedule(env.OUTBOX_RELAY_INTERVAL_MS);
            }
        }
    }

    private async publishBatch(): Promise<void> {
        const lease = this.leadership.current();
        if (!lease) return;
        await this.leases.requireActive(lease);
        const events = await this.outboxEventRepository.findUnpublished(env.OUTBOX_BATCH_SIZE);
        for (const event of events) {
            if (this.stopped) return;
            const correlationId =
                typeof event.payload.correlationId === 'string' ? event.payload.correlationId : undefined;
            try {
                await this.leases.requireActive(lease);
                await this.messagePublisher.publish(
                    event.payload,
                    {
                        topic: event.topic,
                        key: event.partitionKey,
                        headers: {
                            event_type: event.eventType,
                            outbox_event_id: event.outboxEventId,
                        },
                    },
                    lease
                );
                await this.outboxEventRepository.markPublished(event.outboxEventId, lease);
                logger.info(
                    { outboxEventId: event.outboxEventId, hazardId: event.aggregateId, correlationId },
                    'Published outbox event to Kafka'
                );
            } catch (error) {
                if (error instanceof LeaseLostError) {
                    this.leadership.invalidate(lease);
                    return;
                }
                const errorMessage = error instanceof Error ? error.message : String(error);
                await this.outboxEventRepository.recordPublishFailure(event.outboxEventId, errorMessage, lease);
                logger.error(
                    { error, outboxEventId: event.outboxEventId, hazardId: event.aggregateId, correlationId },
                    'Failed to publish outbox event; it will be retried'
                );
                break;
            }
        }
    }
}
