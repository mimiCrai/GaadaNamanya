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
