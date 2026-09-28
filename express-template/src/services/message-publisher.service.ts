import { injectable } from 'inversify';
import amqp, { ChannelModel, Channel } from 'amqplib';
import { logger } from '../libs/logger';
import env from '../util/env';

export interface PublishOptions {
    exchange?: string;
    routingKey: string;
    persistent?: boolean;
}

@injectable()
export class MessagePublisher {
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

            logger.info('RabbitMQ publisher connected');
        } catch (error) {
            logger.error({ error }, 'Failed to connect to RabbitMQ');
            throw error;
        }
    }

    async publish<T>(message: T, options: PublishOptions): Promise<boolean> {
        if (!this.channel) {
            await this.connect();
        }

        if (!this.channel) {
            throw new Error('RabbitMQ channel not available');
        }

        const { exchange = '', routingKey, persistent = true } = options;
        const content = Buffer.from(JSON.stringify(message));

        try {
            // Ensure queue exists if using default exchange
            if (!exchange) {
                await this.channel.assertQueue(routingKey, { durable: true });
            }

            const result = this.channel.publish(exchange, routingKey, content, {
                persistent,
                contentType: 'application/json',
            });

            logger.debug({ routingKey, exchange }, 'Message published');
            return result;
        } catch (error) {
            logger.error({ error, routingKey }, 'Failed to publish message');
            throw error;
        }
    }

    async close(): Promise<void> {
        try {
            if (this.channel) {
                await this.channel.close();
            }
            if (this.connection) {
                await this.connection.close();
            }
            logger.info('RabbitMQ publisher connection closed');
        } catch (error) {
            logger.error({ error }, 'Error closing RabbitMQ connection');
        }
    }
}
