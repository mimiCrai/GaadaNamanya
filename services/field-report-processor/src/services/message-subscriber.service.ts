import { injectable } from 'inversify';
import { Admin, Consumer, Kafka, logLevel } from 'kafkajs';
import { logger } from '../libs/logger';
import { lagMessages } from '../libs/metrics';
import { KafkaRecord } from '../types';
import env from '../util/env';

// resolves once the record is finished; only then is its offset committed
export type MessageHandler = (record: KafkaRecord, heartbeat: () => Promise<void>) => Promise<void>;

export interface SubscribeOptions {
    topic: string;
    fromBeginning?: boolean;
}

export interface IMessageSubscriber {
    connect(): Promise<void>;
    subscribe(options: SubscribeOptions, handler: MessageHandler): Promise<void>;
    isRunning(): boolean;
    close(): Promise<void>;
}

/** Template subscriber on Kafka: autoCommit off, commit after the handler, one record at a time per partition. */
@injectable()
export class MessageSubscriber implements IMessageSubscriber {
    private readonly kafka = new Kafka({ clientId: env.KAFKA_CLIENT_ID, brokers: env.KAFKA_BROKERS, logLevel: logLevel.WARN });
    private consumer: Consumer | null = null;
    private admin: Admin | null = null;
    private joined = false;
    private lagTimer: NodeJS.Timeout | undefined;

    async connect(): Promise<void> {
        try {
            this.consumer = this.kafka.consumer({ groupId: env.KAFKA_GROUP_ID, allowAutoTopicCreation: false });
            this.consumer.on(this.consumer.events.GROUP_JOIN, () => (this.joined = true));
            this.consumer.on(this.consumer.events.CRASH, () => (this.joined = false));
            this.consumer.on(this.consumer.events.STOP, () => (this.joined = false));
            await this.consumer.connect();
            this.admin = this.kafka.admin();
            await this.admin.connect();
            logger.info({ groupId: env.KAFKA_GROUP_ID }, 'Kafka consumer connected');
        } catch (error) {
            this.consumer = null;
            logger.error({ error }, 'Failed to connect Kafka consumer');
            throw error;
        }
    }

    async subscribe(options: SubscribeOptions, handler: MessageHandler): Promise<void> {
        if (!this.consumer) await this.connect();
        if (!this.consumer) throw new Error('Kafka consumer is not available');

        const { topic, fromBeginning = true } = options;
        await this.consumer.subscribe({ topic, fromBeginning });
        logger.info({ topic, groupId: env.KAFKA_GROUP_ID }, 'Starting Kafka subscription');

        await this.consumer.run({
            autoCommit: false,
            partitionsConsumedConcurrently: 1,
            eachMessage: async ({ topic, partition, message, heartbeat }) => {
                const headers = Object.fromEntries(
                    Object.entries(message.headers ?? {}).map(([key, value]) => [key, value?.toString() ?? ''])
                );
                await handler({ topic, partition, offset: message.offset, value: message.value, headers }, heartbeat);
                // at-least-once: a crash before this line redelivers the record; the store insert is idempotent
                await this.consumer?.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
            },
        });
        this.lagTimer = setInterval(() => void this.measureLag(topic), env.LAG_POLL_INTERVAL_MS);
        this.lagTimer.unref();
    }

    isRunning(): boolean {
        return this.joined;
    }

    async close(): Promise<void> {
        clearInterval(this.lagTimer);
        try {
            await this.consumer?.disconnect();
            await this.admin?.disconnect();
            this.consumer = null;
            this.admin = null;
            logger.info('Kafka consumer disconnected');
        } catch (error) {
            logger.error({ error }, 'Error disconnecting Kafka consumer');
        }
    }

    // lag = sum(high watermark - committed offset); never committed = from the low watermark
    private async measureLag(topic: string): Promise<void> {
        if (!this.admin) return;
        try {
            const [ends, [committed]] = await Promise.all([
                this.admin.fetchTopicOffsets(topic),
                this.admin.fetchOffsets({ groupId: env.KAFKA_GROUP_ID, topics: [topic] }),
            ]);
            const byPartition = new Map(committed.partitions.map((p) => [p.partition, BigInt(p.offset)]));
            let lag = 0n;
            for (const end of ends) {
                const done = byPartition.get(end.partition) ?? -1n;
                const from = done < 0n ? BigInt(end.low) : done;
                lag += BigInt(end.high) - from;
            }
            lagMessages.set(Number(lag));
        } catch (error) {
            logger.warn({ error }, 'Could not measure consumer lag');
        }
    }
}
