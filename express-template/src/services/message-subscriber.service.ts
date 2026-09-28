import { injectable } from 'inversify';
import amqp, { ChannelModel, Channel, ConsumeMessage } from 'amqplib';
import { logger } from '../libs/logger';
import env from '../util/env';

export type MessageHandler<T> = (message: T, ack: () => void, nack: (requeue?: boolean) => void) => Promise<void>;

export interface SubscribeOptions {
    queue: string;
    prefetch?: number;
}

@injectable()
export class MessageSubscriber {
    private connection: ChannelModel | null = null;
    private channel: Channel | null = null;

    async connect(): Promise<void> {
        try {
            this.connection = await amqp.connect(env.RABBITMQ_URL);
            this.channel = await this.connection.createChannel();

            this.connection.on('error', (err) => {
                logger.error({ err }, 'RabbitMQ connection error');
            });

            this.connection.on('close', () => {
                logger.warn('RabbitMQ connection closed');
                this.connection = null;
                this.channel = null;
            });

            logger.info('RabbitMQ subscriber connected');
        } catch (error) {
            logger.error({ error }, 'Failed to connect to RabbitMQ');
            throw error;
        }
    }

    async subscribe<T>(options: SubscribeOptions, handler: MessageHandler<T>): Promise<void> {
        if (!this.channel) {
            await this.connect();
        }

        if (!this.channel) {
            throw new Error('RabbitMQ channel not available');
        }

        const { queue, prefetch = 10 } = options;

        // Ensure queue exists
        await this.channel.assertQueue(queue, { durable: true });
        await this.channel.prefetch(prefetch);

        logger.info({ queue, prefetch }, 'Starting to consume messages');

        await this.channel.consume(queue, async (msg: ConsumeMessage | null) => {
            if (!msg || !this.channel) return;

            try {
                const content = JSON.parse(msg.content.toString()) as T;

                const ack = () => this.channel?.ack(msg);
                const nack = (requeue = false) => this.channel?.nack(msg, false, requeue);

                await handler(content, ack, nack);
            } catch (error) {
                logger.error({ error, queue }, 'Error processing message');
                // Reject and don't requeue on parse/handler errors
                this.channel.nack(msg, false, false);
            }
        });
    }

    async close(): Promise<void> {
        try {
            if (this.channel) {
                await this.channel.close();
            }
            if (this.connection) {
                await this.connection.close();
            }
            logger.info('RabbitMQ subscriber connection closed');
        } catch (error) {
            logger.error({ error }, 'Error closing RabbitMQ connection');
        }
    }
}
