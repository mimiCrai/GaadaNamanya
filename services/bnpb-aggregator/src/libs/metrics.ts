import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();
const PREFIX = 'bnpb_aggregator_';

if (process.env.NODE_ENV !== 'test') {
    collectDefaultMetrics({ register: metricsRegistry, prefix: PREFIX });
}

export const parseFailuresTotal = new Counter({
    name: `${PREFIX}parse_failures_total`,
    help: 'Inbound messages that could not be processed, by source and failure category',
    labelNames: ['source', 'reason'] as const,
    registers: [metricsRegistry],
});

export const unprocessedRetryTotal = new Counter({
    name: `${PREFIX}unprocessed_retry_total`,
    help: 'Retry attempts of unprocessed messages, by outcome (recovered|retry|parked|lost_claim)',
    labelNames: ['source', 'outcome'] as const,
    registers: [metricsRegistry],
});

type UnprocessedCounter = () => Promise<Array<{ source: string; status: string; count: number }>>;
let unprocessedCounter: UnprocessedCounter | undefined;

export function setUnprocessedCounter(counter: UnprocessedCounter): void {
    unprocessedCounter = counter;
}

export const unprocessedMessagesGauge = new Gauge({
    name: `${PREFIX}unprocessed_messages`,
    help: 'Unprocessed messages currently stored, by source and status (retrying|parked|recovered)',
    labelNames: ['source', 'status'] as const,
    registers: [metricsRegistry],
    async collect() {
        if (!unprocessedCounter) return;
        try {
            const rows = await unprocessedCounter();
            this.reset();
            for (const row of rows) this.set({ source: row.source, status: row.status }, row.count);
            unprocessedScrapeErrors.set(0);
        } catch {
            unprocessedScrapeErrors.set(1);
        }
    },
});

export const unprocessedScrapeErrors = new Gauge({
    name: `${PREFIX}unprocessed_messages_scrape_error`,
    help: '1 when the last unprocessed_messages count could not be read from the store',
    registers: [metricsRegistry],
});

const SAT = `${PREFIX}satellite_`;

export const satelliteStreamConnected = new Gauge({
    name: `${SAT}stream_connected`,
    help: '1 while this instance holds an open SSE connection to the satellite feed',
    registers: [metricsRegistry],
});

export const satelliteLatestOffset = new Gauge({
    name: `${SAT}latest_offset`,
    help: 'latest_offset reported by GET /v1/session (polled at low frequency by the leader)',
    registers: [metricsRegistry],
});

export const satelliteLastOffsetReceived = new Gauge({
    name: `${SAT}last_offset_received`,
    help: 'Highest offset accepted from the stream on the current connection',
    registers: [metricsRegistry],
});

export const satelliteLastOffsetDurable = new Gauge({
    name: `${SAT}last_offset_durable`,
    help: 'Highest offset committed to the satellite.raw topic (the checkpoint)',
    registers: [metricsRegistry],
});

export const satelliteLagOffsets = new Gauge({
    name: `${SAT}lag_offsets`,
    help: 'latest_offset - last_offset_durable',
    registers: [metricsRegistry],
    collect() {
        const latest = satelliteLagInputs.latest;
        const durable = satelliteLagInputs.durable;
        if (latest === null || durable === null) {
            this.reset();
            return;
        }
        this.set(Math.max(0, latest - durable));
    },
});

export const satelliteLagInputs: { latest: number | null; durable: number | null } = { latest: null, durable: null };

export const satelliteReconnectsTotal = new Counter({
    name: `${SAT}reconnects_total`,
    help: 'Stream (re)connections caused by the previous connection ending, by reason',
    labelNames: ['reason'] as const,
    registers: [metricsRegistry],
});

export const satelliteEventsTotal = new Counter({
    name: `${SAT}events_total`,
    help: 'Accepted stream events by type (detection|update|retract|heartbeat|unprocessed)',
    labelNames: ['type'] as const,
    registers: [metricsRegistry],
});

export const satelliteDuplicatesTotal = new Counter({
    name: `${SAT}duplicates_total`,
    help: 'Events dropped because their offset was <= the last accepted offset',
    registers: [metricsRegistry],
});

export const satelliteGapsTotal = new Counter({
    name: `${SAT}gaps_total`,
    help: 'Offset gaps detected (offset > last + 1); each one forces a reconnect from the durable checkpoint',
    registers: [metricsRegistry],
});

export const satelliteSessionPollErrorsTotal = new Counter({
    name: `${SAT}session_poll_errors_total`,
    help: 'Failed GET /v1/session polls',
    registers: [metricsRegistry],
});

export const satelliteLastHeartbeatVirtualNow = new Gauge({
    name: `${SAT}last_heartbeat_virtual_now_seconds`,
    help: 'virtual_now of the last heartbeat accepted, as Unix seconds (feed virtual clock)',
    registers: [metricsRegistry],
});

export const satelliteBatchCommitSeconds = new Histogram({
    name: `${SAT}batch_commit_seconds`,
    help: 'Duration of one transactional append (records + checkpoint) to satellite.raw',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [metricsRegistry],
});

export const satelliteCheckpointRecoveredTotal = new Counter({
    name: `${SAT}checkpoint_recovered_total`,
    help: 'Checkpoints rebuilt by reading the tail of satellite.raw because the checkpoint offset was missing',
    registers: [metricsRegistry],
});
