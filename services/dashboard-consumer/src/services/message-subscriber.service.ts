import { injectable } from 'inversify';
import { Consumer, Kafka } from 'kafkajs';
import { logger } from '../libs/logger';
import env from '../util/env';

export type MessageHandler<T> = (message: T) => Promise<void>;

export interface SubscribeOptions {
    topic: string;
    fromBeginning?: boolean;
}

@injectable()
export class MessageSubscriber {
    private readonly kafka = new Kafka({
        clientId: env.KAFKA_CLIENT_ID,
        brokers: env.KAFKA_BROKERS,
    });
    private consumer: Consumer | null = null;

    async connect(): Promise<void> {
        try {
            this.consumer = this.kafka.consumer({ groupId: env.KAFKA_GROUP_ID });
            await this.consumer.connect();
            logger.info({ groupId: env.KAFKA_GROUP_ID }, 'Kafka consumer connected');
        } catch (error) {
            this.consumer = null;
            logger.error({ error }, 'Failed to connect Kafka consumer');
            throw error;
        }
    }

    async subscribe<T>(options: SubscribeOptions, handler: MessageHandler<T>): Promise<void> {
        if (!this.consumer) {
            await this.connect();
        }

        if (!this.consumer) {
            throw new Error('Kafka consumer is not available');
        }

        const { topic, fromBeginning = false } = options;
        await this.consumer.subscribe({ topic, fromBeginning });
        logger.info({ topic, groupId: env.KAFKA_GROUP_ID }, 'Starting Kafka subscription');

        await this.consumer.run({
            autoCommit: false,
            eachMessage: async ({ topic, partition, message }) => {
                try {
                    await handler(JSON.parse(message.value?.toString() ?? 'null') as T);
                    await this.consumer?.commitOffsets([
                        { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
                    ]);
                } catch (error) {
                    logger.error({ error, topic, partition, offset: message.offset }, 'Error processing Kafka message');
                    throw error;
                }
            },
        });
    }

    async close(): Promise<void> {
        try {
            if (this.consumer) {
                await this.consumer.disconnect();
                this.consumer = null;
            }
            logger.info('Kafka consumer disconnected');
        } catch (error) {
            logger.error({ error }, 'Error disconnecting Kafka consumer');
        }
    }
}
