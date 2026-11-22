import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();
const PREFIX = 'bnpb_fire_processor_';

if (process.env.NODE_ENV !== 'test') collectDefaultMetrics({ register: metricsRegistry, prefix: PREFIX });

export const recordsTotal = new Counter({
    name: `${PREFIX}records_total`,
    help: 'satellite.raw records processed by the engine, by outcome (applied, duplicate, late, heartbeat, ...)',
    labelNames: ['outcome'] as const,
    registers: [metricsRegistry],
});

export const lastFeedOffset = new Gauge({
    name: `${PREFIX}last_feed_offset`,
    help: 'Last feed offset applied to the engine; feed lag = bnpb_aggregator_satellite_latest_offset minus this',
    registers: [metricsRegistry],
});

export const kafkaLagMessages = new Gauge({
    name: `${PREFIX}kafka_lag_messages`,
    help: 'satellite.raw records not yet processed (partition high watermark minus next offset)',
    registers: [metricsRegistry],
});

export const virtualNowSeconds = new Gauge({
    name: `${PREFIX}virtual_now_seconds`,
    help: 'virtual_now of the last heartbeat processed; event-time lag = ingest last_heartbeat_virtual_now minus this',
    registers: [metricsRegistry],
});

export const watermarkSeconds = new Gauge({
    name: `${PREFIX}watermark_seconds`,
    help: 'Event-time watermark (virtual_now minus allowed lateness), never decreases',
    registers: [metricsRegistry],
});

export const allowedLatenessSeconds = new Gauge({
    name: `${PREFIX}allowed_lateness_seconds`,
    help: 'Allowed lateness in effect (from the snapshot when one exists, D-25)',
    registers: [metricsRegistry],
});

export const latenessMismatch = new Gauge({
    name: `${PREFIX}allowed_lateness_mismatch`,
    help: '1 when the configured allowed lateness differs from the restored snapshot (snapshot value is used)',
    registers: [metricsRegistry],
});

export const endToEndSeconds = new Histogram({
    name: `${PREFIX}end_to_end_seconds`,
    help: 'From received_at at the Aggregator ingest to the HazardEvent batch stored (P4 #4 p95)',
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600],
    registers: [metricsRegistry],
});

export const engineGauge = new Gauge({
    name: `${PREFIX}engine`,
    help: 'Engine counters: fires, final_fires, active, single_detections, low_excluded, retracted, late_detections',
    labelNames: ['counter'] as const,
    registers: [metricsRegistry],
});

export const hazardWritesTotal = new Counter({
    name: `${PREFIX}hazard_writes_total`,
    help: 'HazardEvent ops sent to POST /internal/hazards/batch, by op and result',
    labelNames: ['op', 'result'] as const,
    registers: [metricsRegistry],
});

export const aggregatorLatencySeconds = new Histogram({
    name: `${PREFIX}aggregator_request_seconds`,
    help: 'Outbound Aggregator call latency, by operation and outcome',
    labelNames: ['operation', 'outcome'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [metricsRegistry],
});

export const aggregatorErrorsTotal = new Counter({
    name: `${PREFIX}aggregator_errors_total`,
    help: 'Failed Aggregator calls, by operation and kind (transient, permanent)',
    labelNames: ['operation', 'kind'] as const,
    registers: [metricsRegistry],
});

export const flushSeconds = new Histogram({
    name: `${PREFIX}flush_seconds`,
    help: 'Duration of one flush (late detections, DLQ, hazard batch, stats)',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [metricsRegistry],
});

export const snapshotsTotal = new Counter({
    name: `${PREFIX}snapshots_total`,
    help: 'Snapshots sent to the Aggregator, by outcome (stored, stale)',
    labelNames: ['outcome'] as const,
    registers: [metricsRegistry],
});

export const snapshotBytes = new Gauge({
    name: `${PREFIX}snapshot_bytes`,
    help: 'Size of the last gzip snapshot',
    registers: [metricsRegistry],
});
