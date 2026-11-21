import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../telemetry/metrics';

// field report metrics live in B's registry (src/telemetry/metrics.ts), served by its /metrics
export { metricsRegistry };
const PREFIX = 'bnpb_client_api_';

export const fieldReportAcceptSeconds = new Histogram({
    name: `${PREFIX}field_report_accept_seconds`,
    help: 'POST /field-reports latency from request to response, by status (202 = after the Kafka ack)',
    labelNames: ['status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
    registers: [metricsRegistry],
});

export const fieldReportResponsesTotal = new Counter({
    name: `${PREFIX}field_report_responses_total`,
    help: 'POST /field-reports responses by status (202, 400, 401, 403, 413, 503)',
    labelNames: ['status'] as const,
    registers: [metricsRegistry],
});

export const kafkaPublishSeconds = new Histogram({
    name: `${PREFIX}kafka_publish_seconds`,
    help: 'Outbound Kafka publish latency (acks=-1) for field reports, by outcome (ok, timeout, error, not_connected)',
    labelNames: ['outcome'] as const,
    buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2],
    registers: [metricsRegistry],
});
