import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();
const PREFIX = 'bnpb_field_report_processor_';

if (process.env.NODE_ENV !== 'test') collectDefaultMetrics({ register: metricsRegistry, prefix: PREFIX });

export const processedTotal = new Counter({
    name: `${PREFIX}processed_total`,
    help: 'Kafka records finished (offset committed), by result (created, duplicate, conflict, dlq)',
    labelNames: ['result'] as const,
    registers: [metricsRegistry],
});

export const duplicateTotal = new Counter({
    name: `${PREFIX}duplicate_total`,
    help: 'Records whose report_id was already stored with the same content (redelivery or client resend)',
    registers: [metricsRegistry],
});

export const dlqTotal = new Counter({
    name: `${PREFIX}dlq_total`,
    help: 'Records stored in the Aggregator DLQ instead of the field report store, by category',
    labelNames: ['category'] as const,
    registers: [metricsRegistry],
});

export const storeErrorsTotal = new Counter({
    name: `${PREFIX}store_errors_total`,
    help: 'Failed calls to the Aggregator, by kind (transient = backoff without commit, permanent = counted toward DLQ)',
    labelNames: ['kind'] as const,
    registers: [metricsRegistry],
});

export const storeLatencySeconds = new Histogram({
    name: `${PREFIX}store_latency_seconds`,
    help: 'Outbound Aggregator call latency, by operation and outcome',
    labelNames: ['operation', 'outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [metricsRegistry],
});

export const lagMessages = new Gauge({
    name: `${PREFIX}lag_messages`,
    help: 'Consumer group lag on the field-reports topic (high watermark minus committed offset, all partitions)',
    registers: [metricsRegistry],
});
