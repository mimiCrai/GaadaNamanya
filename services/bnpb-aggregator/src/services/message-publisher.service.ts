import { injectable } from 'inversify';
import { Kafka, Producer } from 'kafkajs';
import { logger } from '../libs/logger';
import env from '../util/env';

export interface PublishOptions {
    topic: string;
    key?: string;
    headers?: Record<string, string>;
}

export interface IMessagePublisher {
    connect(): Promise<void>;
    publish<T>(message: T, options: PublishOptions): Promise<void>;
    close(): Promise<void>;
}

@injectable()
export class MessagePublisher implements IMessagePublisher {
    private readonly kafka = new Kafka({
        clientId: env.KAFKA_CLIENT_ID,
        brokers: env.KAFKA_BROKERS,
    });
    private producer: Producer | null = null;

    async connect(): Promise<void> {
        try {
            this.producer = this.kafka.producer();
            await this.producer.connect();
            logger.info('Kafka producer connected');
        } catch (error) {
            this.producer = null;
            logger.error({ error }, 'Failed to connect Kafka producer');
            throw error;
        }
    }

    async publish<T>(message: T, options: PublishOptions): Promise<void> {
        if (!this.producer) {
            await this.connect();
        }

        if (!this.producer) {
            throw new Error('Kafka producer is not available');
        }

        const { topic, key, headers } = options;

        try {
            await this.producer.send({
                topic,
                acks: -1,
                messages: [
                    {
                        key,
                        value: JSON.stringify(message),
                        headers,
                    },
                ],
            });

            logger.debug({ topic, key }, 'Kafka message published');
        } catch (error) {
            logger.error({ error, topic, key }, 'Failed to publish Kafka message');
            throw error;
        }
    }

    async close(): Promise<void> {
        try {
            if (this.producer) {
                await this.producer.disconnect();
                this.producer = null;
            }
            logger.info('Kafka producer disconnected');
        } catch (error) {
            logger.error({ error }, 'Error disconnecting Kafka producer');
        }
    }
}
