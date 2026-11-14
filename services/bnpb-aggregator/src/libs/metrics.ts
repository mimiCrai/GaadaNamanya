import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

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
