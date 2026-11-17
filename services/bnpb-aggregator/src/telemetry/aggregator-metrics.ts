import { Counter, Gauge, Histogram } from 'prom-client';
import type { CanonicalStore } from '../db';
import type { IBackgroundLeadershipService } from '../services/background-leadership.service';
import { metricsRegistry } from './metrics';
import { SourceStream, SourceSyncStatus, sourceSyncStates } from '../db/schema/source-sync-states';
import { outboxEvents } from '../db/schema/outbox-events';

export const pollRuns = new Counter({
    name: 'bnpb_aggregator_poll_runs_total',
    help: 'Source poll outcomes',
    labelNames: ['stream', 'outcome'],
    registers: [metricsRegistry],
});
export const pollDuration = new Histogram({
    name: 'bnpb_aggregator_poll_duration_seconds',
    help: 'Source poll and ingestion duration',
    labelNames: ['stream'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 15],
    registers: [metricsRegistry],
});
export const leadershipChanges = new Counter({
    name: 'bnpb_aggregator_leadership_changes_total',
    help: 'Local leadership transitions',
    labelNames: ['state'],
    registers: [metricsRegistry],
});
export const renewalErrors = new Counter({
    name: 'bnpb_aggregator_lease_renewal_errors_total',
    help: 'Failed leadership renewals',
    registers: [metricsRegistry],
});

export function registerAggregatorCollectors(store: CanonicalStore, leadership: IBackgroundLeadershipService): void {
    new Gauge({
        name: 'bnpb_aggregator_leader',
        help: 'This process currently considers itself leader',
        registers: [metricsRegistry],
        collect() {
            this.set(leadership.current() ? 1 : 0);
        },
    });
    new Gauge({
        name: 'bnpb_aggregator_leader_epoch',
        help: 'Local leader epoch; zero on followers',
        registers: [metricsRegistry],
        collect() {
            this.set(leadership.current()?.epoch ?? 0);
        },
    });
    const errors = new Gauge({
        name: 'bnpb_aggregator_metrics_read_error',
        help: 'Metrics storage snapshot unavailable',
        labelNames: ['collection'],
        registers: [metricsRegistry],
        async collect() {
            const results = await Promise.allSettled([readStates(), readBacklog()]);
            this.set({ collection: sourceSyncStates }, results[0].status === 'rejected' ? 1 : 0);
            this.set({ collection: outboxEvents }, results[1].status === 'rejected' ? 1 : 0);
        },
    });
    const allowed: string[] = Object.values(SourceStream);
    type State = { sourceStream: string; status: string; lastSuccessfulPollAt: Date | null; circuitOpen: boolean };
    let states: Promise<State[]> | undefined;
    let statesUntil = 0;
    const readStates = () => {
        if (!states || performance.now() >= statesUntil) {
            statesUntil = performance.now() + 1000;
            states = store.database
                .collection(sourceSyncStates)
                .aggregate<State>(
                    [
                        {
                            $project: {
                                sourceStream: 1,
                                status: 1,
                                lastSuccessfulPollAt: 1,
                                circuitOpen: { $gt: ['$retryAt', '$$NOW'] },
                            },
                        },
                    ],
                    { maxTimeMS: 1000, timeoutMS: 1200 }
                )
                .toArray();
        }
        return states;
    };
    const stateMetric = (name: string, help: string, value: (row: State) => number) =>
        new Gauge({
            name,
            help,
            labelNames: ['stream'],
            registers: [metricsRegistry],
            async collect() {
                try {
                    const rows = await readStates();
                    this.reset();
                    for (const row of rows)
                        if (allowed.includes(row.sourceStream)) this.set({ stream: row.sourceStream }, value(row));
                    errors.set({ collection: 'source_sync_states' }, 0);
                } catch {
                    this.reset();
                    errors.set({ collection: 'source_sync_states' }, 1);
                }
            },
        });
    stateMetric('bnpb_aggregator_source_state', 'Source state: 0 healthy, 1 stale, 2 unavailable', (row) =>
        row.status === SourceSyncStatus.Healthy ? 0 : row.status === SourceSyncStatus.Stale ? 1 : 2
    );
    stateMetric(
        'bnpb_aggregator_source_last_success_seconds',
        'Database timestamp of last successful poll; zero before first success',
        (row) => (row.lastSuccessfulPollAt ? row.lastSuccessfulPollAt.getTime() / 1000 : 0)
    );
    stateMetric(
        'bnpb_aggregator_source_circuit_open',
        'Source currently in persisted cooldown, measured with database time',
        (row) => (row.circuitOpen ? 1 : 0)
    );

    type Backlog = { pending: number; ageSeconds: number };
    let backlog: Promise<Backlog[]> | undefined;
    let backlogUntil = 0;
    const readBacklog = () => {
        if (!backlog || performance.now() >= backlogUntil) {
            backlogUntil = performance.now() + 1000;
            backlog = store.database
                .collection(outboxEvents)
                .aggregate<Backlog>(
                    [
                        { $match: { publishedAt: null } },
                        { $group: { _id: null, pending: { $sum: 1 }, oldest: { $min: '$createdAt' } } },
                        {
                            $project: {
                                pending: 1,
                                ageSeconds: { $max: [0, { $divide: [{ $subtract: ['$$NOW', '$oldest'] }, 1000] }] },
                            },
                        },
                    ],
                    { maxTimeMS: 1000, timeoutMS: 1200 }
                )
                .toArray();
        }
        return backlog;
    };
    for (const field of ['pending', 'ageSeconds'] as const)
        new Gauge({
            name: field === 'pending' ? 'bnpb_aggregator_outbox_pending' : 'bnpb_aggregator_outbox_oldest_seconds',
            help:
                field === 'pending'
                    ? 'Unpublished outbox records (shared database; aggregate replicas with max)'
                    : 'Age of oldest unpublished outbox record, using database time',
            registers: [metricsRegistry],
            async collect() {
                try {
                    const rows = await readBacklog();
                    this.set(rows[0]?.[field] ?? 0);
                    errors.set({ collection: 'outbox_events' }, 0);
                } catch {
                    this.set(Number.NaN);
                    errors.set({ collection: 'outbox_events' }, 1);
                }
            },
        });
}
