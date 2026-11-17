import type { CanonicalStore } from '../../src/db';
import type { IBackgroundLeadershipService } from '../../src/services/background-leadership.service';
import { registerAggregatorCollectors } from '../../src/telemetry/aggregator-metrics';
import { metricsRegistry } from '../../src/telemetry/metrics';

describe('Aggregator storage metrics', () => {
    beforeEach(() => metricsRegistry.clear());

    it('shares bounded snapshots within a scrape and reports local leadership separately from shared storage', async () => {
        const aggregate = jest.fn((pipeline: unknown[]) => ({
            toArray: async () =>
                JSON.stringify(pipeline).includes('publishedAt')
                    ? [{ pending: 4, ageSeconds: 12 }]
                    : [
                          {
                              sourceStream: 'SENSOR_PANTAI',
                              status: 'STALE',
                              lastSuccessfulPollAt: new Date(5000),
                              circuitOpen: true,
                          },
                      ],
        }));
        const store = { database: { collection: jest.fn(() => ({ aggregate })) } };
        registerAggregatorCollectors(
            store as unknown as CanonicalStore,
            {
                current: () => ({ ownerId: 'instance-one', epoch: 7 }),
            } as IBackgroundLeadershipService
        );
        const text = await metricsRegistry.metrics();
        expect(text).toContain('bnpb_aggregator_leader 1');
        expect(text).toContain('bnpb_aggregator_leader_epoch 7');
        expect(text).toContain('bnpb_aggregator_outbox_pending 4');
        expect(text).toContain('bnpb_aggregator_outbox_oldest_seconds 12');
        expect(text).toContain('bnpb_aggregator_source_circuit_open{stream="SENSOR_PANTAI"} 1');
        expect(text).toContain('bnpb_aggregator_source_last_success_seconds{stream="SENSOR_PANTAI"} 5');
        expect(aggregate).toHaveBeenCalledTimes(2);
        for (const [, options] of aggregate.mock.calls as unknown as Array<[unknown, unknown]>) {
            expect(options).toEqual({ maxTimeMS: 1000, timeoutMS: 1200 });
        }
    });

    it('keeps /metrics usable during a storage outage without reporting an empty healthy backlog', async () => {
        const store = {
            database: {
                collection: () => ({
                    aggregate: () => ({
                        toArray: async () => {
                            throw new Error('private storage address');
                        },
                    }),
                }),
            },
        };
        registerAggregatorCollectors(
            store as unknown as CanonicalStore,
            { current: () => null } as IBackgroundLeadershipService
        );
        const text = await metricsRegistry.metrics();
        expect(text).toContain('bnpb_aggregator_leader 0');
        expect(text).toContain('bnpb_aggregator_metrics_read_error{collection="outbox_events"} 1');
        expect(text).toContain('bnpb_aggregator_metrics_read_error{collection="source_sync_states"} 1');
        expect(text).not.toMatch(/bnpb_aggregator_outbox_pending 0|private storage address/);
    });
});
