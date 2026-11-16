import { inject, injectable } from 'inversify';
import { Kafka, Message, Producer, Transaction } from 'kafkajs';
import { logger } from '../libs/logger';
import env from '../util/env';
import { TYPES } from '../constants/types';
import { LeaseToken } from '../db/schema/background-leases';
import { IBackgroundLeaseRepository } from '../repositories/background-lease.repository';

export interface PublishOptions {
    topic: string;
    key?: string;
    headers?: Record<string, string>;
}

export interface IMessagePublisher {
    connect(): Promise<void>;
    publish<T>(message: T, options: PublishOptions, lease: LeaseToken): Promise<void>;
    publishBatch(messages: { message: unknown; options: PublishOptions }[], lease: LeaseToken): Promise<void>;
    close(): Promise<void>;
}

@injectable()
export class MessagePublisher implements IMessagePublisher {
    private readonly kafka = new Kafka({
        clientId: env.KAFKA_CLIENT_ID,
        brokers: env.KAFKA_BROKERS,
    });
    private producer: Producer | null = null;
    private epoch: number | undefined;

    constructor(@inject(TYPES.IBackgroundLeaseRepository) private readonly leases: IBackgroundLeaseRepository) {}

    async connect(): Promise<void> {
        try {
            this.producer = this.kafka.producer({
                transactionalId: env.KAFKA_TRANSACTIONAL_ID,
                idempotent: true,
                maxInFlightRequests: 1,
                transactionTimeout: env.BACKGROUND_LEASE_MS,
            });
            await this.producer.connect();
            logger.info('Kafka producer connected');
        } catch (error) {
            this.producer = null;
            logger.error({ error }, 'Failed to connect Kafka producer');
            throw error;
        }
    }

    async publish<T>(message: T, options: PublishOptions, lease: LeaseToken): Promise<void> {
        const { topic, key, headers } = options;
        return this.transact(
            lease,
            (transaction) =>
                transaction.send({
                    topic,
                    acks: -1,
                    messages: [
                        {
                            key,
                            value: JSON.stringify(message),
                            headers: { ...headers, fencing_token: String(lease.epoch) },
                        },
                    ],
                }),
            { topic, key }
        );
    }

    async publishBatch(messages: { message: unknown; options: PublishOptions }[], lease: LeaseToken): Promise<void> {
        if (!messages.length) return;
        const chunks = [new Map<string, Message[]>()];
        let bytes = 0;
        for (const { message, options } of messages) {
            const value = JSON.stringify(message);
            const size = Buffer.byteLength(value) + Buffer.byteLength(JSON.stringify(options)) + 256;
            if (size > 512 * 1024) throw new Error('Kafka record exceeds publisher batch byte limit');
            if (bytes + size > 512 * 1024) {
                chunks.push(new Map());
                bytes = 0;
            }
            const topics = chunks[chunks.length - 1];
            const records = topics.get(options.topic) ?? [];
            records.push({
                key: options.key,
                value,
                headers: { ...options.headers, fencing_token: String(lease.epoch) },
            });
            topics.set(options.topic, records);
            bytes += size;
        }
        return this.transact(
            lease,
            async (transaction) => {
                for (const topics of chunks)
                    await transaction.sendBatch({
                        acks: -1,
                        topicMessages: [...topics].map(([topic, records]) => ({ topic, messages: records })),
                    });
            },
            { count: messages.length, chunks: chunks.length }
        );
    }

    private async transact(
        lease: LeaseToken,
        send: (transaction: Transaction) => Promise<unknown>,
        context: Record<string, unknown>
    ): Promise<void> {
        await this.leases.requireActive(lease);
        if (this.epoch !== lease.epoch) {
            await this.close();
            this.epoch = lease.epoch;
        }
        if (!this.producer) {
            await this.connect();
        }

        if (!this.producer) {
            throw new Error('Kafka producer is not available');
        }

        await this.leases.requireActive(lease);
        let transaction: Transaction | undefined;
        try {
            transaction = await this.producer.transaction();
            await send(transaction);
            await this.leases.requireActive(lease);
            await transaction.commit();
            logger.debug(context, 'Kafka message transaction committed');
        } catch (error) {
            await transaction?.abort().catch(() => undefined);
            await this.close();
            logger.error({ error, ...context }, 'Failed to publish Kafka message');
            throw error;
        }
    }

    async close(): Promise<void> {
        this.epoch = undefined;
        const producer = this.producer;
        this.producer = null;
        try {
            if (producer) await producer.disconnect();
            logger.info('Kafka producer disconnected');
        } catch (error) {
            logger.error({ error }, 'Error disconnecting Kafka producer');
        }
    }
}
