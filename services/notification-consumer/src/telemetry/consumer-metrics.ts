import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from './metrics';

export const consumedMessages = new Counter({
    name: 'bnpb_consumer_messages_total',
    help: 'Kafka processing outcomes',
    labelNames: ['topic', 'group', 'outcome'],
    registers: [metricsRegistry],
});
export const consumerDuration = new Histogram({
    name: 'bnpb_consumer_processing_seconds',
    help: 'Kafka processing duration including offset acknowledgement',
    labelNames: ['topic', 'group'],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
    registers: [metricsRegistry],
});

export const criticalNotificationProcessing = new Histogram({
    name: 'bnpb_critical_notification_processing_seconds',
    help: 'Local critical notification processing duration through inbox commit, measured with a monotonic clock; not end-to-end latency',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 4, 5, 10, 30, 60],
    registers: [metricsRegistry],
});
