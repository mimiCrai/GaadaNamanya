import { inject, injectable } from 'inversify';
import { Consumer, EachBatchPayload, Kafka, logLevel } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { IAggregatorClient, StaleSnapshotError } from '../clients/aggregator.client';
import { TYPES } from '../constants/types';
import { logger } from '../libs/logger';
import { kafkaLagMessages } from '../libs/metrics';
import env from '../util/env';
import { FirePipeline, PipelineStoppedError } from './fire-pipeline.service';

export interface FireRuntimeStatus {
    ready: boolean;
    restoring: boolean;
    seek_offset: string | null;
    kafka_lag: number | null;
    restarts: number;
}

export interface IFireConsumer {
    start(): Promise<void>;
    stop(): Promise<void>;
    status(): FireRuntimeStatus;
    stats(): Record<string, unknown>;
}

const PARTITION = 0;

// one partition = one active owner in the group; position always comes from the snapshot, never from memory
@injectable()
export class FireConsumer implements IFireConsumer {
    readonly instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    readonly pipeline: FirePipeline;
    private readonly kafka = new Kafka({ clientId: env.KAFKA_CLIENT_ID, brokers: env.KAFKA_BROKERS, logLevel: logLevel.WARN });
    private consumer: Consumer | null = null;
    private joined = false;
    private restoring = false;
    private stopping = false;
    private seekOffset: string | null = null;
    private lag: number | null = null;
    private restarts = 0;

    constructor(@inject(TYPES.IAggregatorClient) client: IAggregatorClient) {
        this.pipeline = new FirePipeline(client, {
            allowedLatenessMs: env.FIRE_ALLOWED_LATENESS_MINUTES * 60_000,
            instanceId: this.instanceId,
            batchMaxOps: env.FIRE_BATCH_MAX_OPS,
            batchMaxBytes: env.FIRE_BATCH_MAX_BYTES,
            snapshotEveryRecords: env.FIRE_SNAPSHOT_EVERY_RECORDS,
            snapshotIntervalMs: env.FIRE_SNAPSHOT_INTERVAL_MS,
            backoffBaseMs: env.FIRE_BACKOFF_BASE_MS,
            backoffCapMs: env.FIRE_BACKOFF_CAP_MS,
        });
    }

    async start(): Promise<void> {
        this.stopping = false;
        this.restoring = true;
        const correlationId = randomUUID();
        try {
            // restore first: nothing is consumed until the engine state matches the seek position
            this.seekOffset = await this.pipeline.restore(correlationId);
            const consumer = this.kafka.consumer({ groupId: env.KAFKA_GROUP_ID, allowAutoTopicCreation: false });
            consumer.on(consumer.events.GROUP_JOIN, () => (this.joined = true));
            consumer.on(consumer.events.CRASH, () => (this.joined = false));
            consumer.on(consumer.events.STOP, () => (this.joined = false));
            await consumer.connect();
            await consumer.subscribe({ topic: env.SATELLITE_RAW_TOPIC, fromBeginning: true });
            this.consumer = consumer;
            await consumer.run({
                autoCommit: false,
                eachBatchAutoResolve: false,
                partitionsConsumedConcurrently: 1,
                eachBatch: (payload) => this.onBatch(payload),
            });
            consumer.seek({ topic: env.SATELLITE_RAW_TOPIC, partition: PARTITION, offset: this.seekOffset });
            logger.info(
                { topic: env.SATELLITE_RAW_TOPIC, seek: this.seekOffset, instanceId: this.instanceId, correlationId },
                'Fire processor consuming satellite.raw'
            );
        } finally {
            this.restoring = false;
        }
    }

    async stop(): Promise<void> {
        this.stopping = true;
        this.pipeline.stop();
        const consumer = this.consumer;
        this.consumer = null;
        await consumer?.disconnect().catch((error) => logger.error({ error }, 'Error disconnecting Kafka consumer'));
        this.joined = false;
    }

    status(): FireRuntimeStatus {
        return {
            ready: this.joined && !this.restoring,
            restoring: this.restoring,
            seek_offset: this.seekOffset,
            kafka_lag: this.lag,
            restarts: this.restarts,
        };
    }

    stats(): Record<string, unknown> {
        return { ...this.pipeline.stats(), runtime: this.status() };
    }

    private async onBatch({ batch, resolveOffset, heartbeat, isRunning, isStale }: EachBatchPayload): Promise<void> {
        const correlationId = randomUUID();
        try {
            for (const message of batch.messages) {
                if (!isRunning() || isStale() || this.stopping) break;
                this.pipeline.ingest({ offset: message.offset, value: message.value });
                resolveOffset(message.offset);
                this.lag = Math.max(0, Number(BigInt(batch.highWatermark) - BigInt(message.offset) - 1n));
                kafkaLagMessages.set(this.lag);
                if (this.pipeline.unflushedRecords >= env.FIRE_FLUSH_MAX_RECORDS) await this.cycle(batch.topic, correlationId, heartbeat);
            }
            if (!this.stopping) await this.cycle(batch.topic, correlationId, heartbeat);
        } catch (error) {
            if (error instanceof PipelineStoppedError) return;
            if (error instanceof StaleSnapshotError) {
                // a newer instance owns the state: drop ours and rebuild from its snapshot
                logger.error({ error, instanceId: this.instanceId, correlationId }, 'Fire processor fenced by a newer snapshot; restarting');
                setImmediate(() => void this.restart());
                return;
            }
            throw error;
        }
    }

    // flush, snapshot when due, and commit the Kafka offset only once the snapshot covering it is stored
    private async cycle(topic: string, correlationId: string, heartbeat: () => Promise<void>): Promise<void> {
        await this.pipeline.flush(correlationId, heartbeat);
        const covered = await this.pipeline.maybeSnapshot(correlationId, heartbeat);
        if (covered !== null && this.consumer) {
            await this.consumer.commitOffsets([{ topic, partition: PARTITION, offset: (BigInt(covered) + 1n).toString() }]);
        }
    }

    private async restart(): Promise<void> {
        this.restarts++;
        await this.stop();
        for (let attempt = 1; ; attempt++) {
            try {
                await this.start();
                return;
            } catch (error) {
                logger.warn({ error, attempt }, 'Fire processor restart failed; retrying');
                await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * attempt)));
            }
        }
    }
}
