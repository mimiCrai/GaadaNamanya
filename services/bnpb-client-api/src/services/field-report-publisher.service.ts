import { injectable } from 'inversify';
import { Kafka, logLevel, Producer, RecordMetadata } from 'kafkajs';
import { logger } from '../libs/logger';
import { kafkaPublishSeconds } from '../libs/metrics';
import env from '../util/env';
import { FieldReportMessage } from '../types/field-report';

export class PublishUnavailableError extends Error {
    constructor(readonly reason: 'disabled' | 'not_connected' | 'timeout' | 'error', cause?: unknown) {
        super(`Kafka tidak terjangkau (${reason})`, { cause });
        this.name = 'PublishUnavailableError';
    }
}

export interface PublishResult {
    partition: number;
    offset: string;
}

export interface IFieldReportPublisher {
    start(): void;
    stop(): Promise<void>;
    isReady(): boolean;
    publish(message: FieldReportMessage, correlationId: string): Promise<PublishResult>;
}

/**
 * D-38: idempotent producer, acks=-1; the caller answers 202 only after this resolves (the Kafka ack).
 * Connects in the background and reconnects forever; readiness is false until connected.
 */
@injectable()
export class FieldReportPublisher implements IFieldReportPublisher {
    private producer: Producer | undefined;
    private connected = false;
    private stopped = false;
    private waiters: (() => void)[] = [];

    start(): void {
        if (env.KAFKA_BROKERS.length === 0 || this.producer) return;
        const kafka = new Kafka({
            clientId: env.KAFKA_CLIENT_ID,
            brokers: env.KAFKA_BROKERS,
            logLevel: logLevel.WARN,
            retry: { retries: 5, initialRetryTime: 100, maxRetryTime: 1_000 },
        });
        this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: false });
        this.producer.on(this.producer.events.DISCONNECT, () => {
            this.connected = false;
            if (!this.stopped) void this.connectLoop();
        });
        void this.connectLoop();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        await this.producer?.disconnect().catch(() => undefined);
    }

    isReady(): boolean {
        return env.KAFKA_BROKERS.length === 0 || this.connected;
    }

    async publish(message: FieldReportMessage, correlationId: string): Promise<PublishResult> {
        const startedAt = performance.now();
        const deadline = Date.now() + env.FIELD_REPORT_PUBLISH_TIMEOUT_MS;
        const observe = (outcome: string) => kafkaPublishSeconds.observe({ outcome }, (performance.now() - startedAt) / 1000);
        if (!this.producer) {
            observe('not_connected');
            throw new PublishUnavailableError('disabled');
        }
        // just restarted: wait for the connection within the same budget instead of rejecting at once
        if (!this.connected && !(await this.waitConnected(deadline - Date.now()))) {
            observe('not_connected');
            throw new PublishUnavailableError('not_connected');
        }
        let timer: NodeJS.Timeout | undefined;
        try {
            const send = this.producer.send({
                topic: env.FIELD_REPORT_TOPIC,
                acks: -1,
                timeout: env.FIELD_REPORT_PUBLISH_TIMEOUT_MS,
                messages: [
                    {
                        key: message.report.report_id,
                        value: JSON.stringify(message),
                        headers: { correlation_id: correlationId, report_id: message.report.report_id },
                    },
                ],
            });
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new PublishUnavailableError('timeout')), Math.max(0, deadline - Date.now()));
            });
            const [metadata] = (await Promise.race([send, timeout])) as RecordMetadata[];
            observe('ok');
            logger.info(
                {
                    target: 'kafka',
                    topic: env.FIELD_REPORT_TOPIC,
                    reportId: message.report.report_id,
                    partition: metadata.partition,
                    offset: metadata.baseOffset,
                    latencyMs: Math.round(performance.now() - startedAt),
                    correlationId,
                },
                'Outgoing request completed'
            );
            return { partition: metadata.partition, offset: String(metadata.baseOffset ?? metadata.offset ?? '') };
        } catch (error) {
            const reason = error instanceof PublishUnavailableError ? error.reason : 'error';
            observe(reason);
            logger.warn(
                { target: 'kafka', reportId: message.report.report_id, reason, error, correlationId },
                'Field report publish failed'
            );
            throw error instanceof PublishUnavailableError ? error : new PublishUnavailableError('error', error);
        } finally {
            clearTimeout(timer);
        }
    }

    private async connectLoop(): Promise<void> {
        for (let attempt = 1; !this.stopped && !this.connected; attempt++) {
            try {
                await this.producer!.connect();
                this.connected = true;
                this.waiters.splice(0).forEach((wake) => wake());
                logger.info({ brokers: env.KAFKA_BROKERS, attempt }, 'Field report producer connected');
            } catch (error) {
                logger.warn({ error, attempt }, 'Field report producer could not connect; retrying');
                await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 250 * attempt)));
            }
        }
    }

    private waitConnected(ms: number): Promise<boolean> {
        if (this.connected) return Promise.resolve(true);
        return new Promise((resolve) => {
            const wake = () => {
                clearTimeout(timer);
                resolve(true);
            };
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter((waiter) => waiter !== wake);
                resolve(false);
            }, Math.max(0, ms));
            this.waiters.push(wake);
        });
    }
}
