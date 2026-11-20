import { SensorPantaiService } from '../../src/services/sensor-pantai.service';
import { SensorSyncState } from '../../src/repositories/sensor-pantai.repository';
import { SourceStream, SourceSyncStatus } from '../../src/db/schema/source-sync-states';
import { LeaseLostError } from '../../src/db/schema/background-leases';
import { SensorClientError } from '../../src/clients/sensor-pantai.types';
import env from '../../src/util/env';
import { sensorCircuitState } from '../../src/libs/metrics';

describe('Sensor Pantai ingestion', () => {
    const lease = { ownerId: 'leader', epoch: 7 };
    const now = new Date('2026-11-14T10:00:00Z');
    const sourceTime = new Date('2026-11-12T00:00:00Z');
    const station = {
        station_id: 'station',
        name: 'Padang',
        province: 'Sumatera Barat',
        latitude: -0.9,
        longitude: 100.3,
    };
    const observation = {
        observation_id: 'obs-a',
        station_id: 'station',
        observed_at: sourceTime.toISOString(),
        sea_level_anomaly_m: -0.4,
        wave_height_m: 1.2,
        quality: 'ok',
        critical: true,
    };
    const client = { getStations: jest.fn(), getObservations: jest.fn() };
    const repository = {
        getState: jest.fn(),
        checkpoint: jest.fn(),
        reject: jest.fn(),
        rejectBatch: jest.fn(),
        recordFailure: jest.fn(),
        getRejected: jest.fn(),
    };
    const hazards = { upsertBatchAndEnqueue: jest.fn() };
    const leadership = { current: jest.fn(), invalidate: jest.fn() };
    const leases = { requireActive: jest.fn() };
    let service: SensorPantaiService;
    let state: SensorSyncState;
    const poll = () => (service as unknown as { pollOnce(): Promise<void> }).pollOnce();

    beforeEach(() => {
        jest.resetAllMocks();
        sensorCircuitState.reset();
        state = {
            sourceStream: SourceStream.SensorPantai,
            status: SourceSyncStatus.Unavailable,
            lastSuccessfulPollAt: null,
            lastAttemptAt: null,
            staleSince: null,
            lastError: null,
            consecutiveFailures: 0,
            cursor: 'saved',
            stations: [station],
            stationsUpdatedAt: now,
            generatedAt: null,
            latestObservedAt: null,
            sourceProgressAt: null,
            retryAt: null,
        };
        repository.getState.mockImplementation(async () => structuredClone(state));
        repository.checkpoint.mockImplementation(async (next) => structuredClone(next));
        leadership.current.mockReturnValue(lease);
        leases.requireActive.mockResolvedValue(now);
        client.getStations.mockResolvedValue([station]);
        client.getObservations.mockResolvedValue({ generatedAt: sourceTime, items: [observation], nextCursor: null });
        hazards.upsertBatchAndEnqueue.mockImplementation(async (inputs) =>
            inputs.map((input: Record<string, unknown>) => ({
                changeType: 'hazard.created',
                hazardEvent: { ...input, hazardId: 'canonical-id' },
            }))
        );
        service = new SensorPantaiService(client, repository, hazards as never, leadership as never, leases as never);
        (service as unknown as { stopped: boolean }).stopped = false;
    });

    it('keeps followers from calling the source', async () => {
        leadership.current.mockReturnValue(null);
        await poll();
        expect(client.getObservations).not.toHaveBeenCalled();
        expect(repository.getState).not.toHaveBeenCalled();
    });

    it('honours the persisted open circuit using database time', async () => {
        state.retryAt = new Date(now.getTime() + 1000);
        await poll();
        expect(client.getStations).not.toHaveBeenCalled();
        expect(client.getObservations).not.toHaveBeenCalled();
        expect((await sensorCircuitState.get()).values[0].value).toBe(1);
    });

    it('maps a critical observation to COASTAL/AWAS using source station coordinates', async () => {
        await poll();
        expect(hazards.upsertBatchAndEnqueue).toHaveBeenCalledWith([
            expect.objectContaining({
                source: 'SENSOR_PANTAI',
                hazardType: 'COASTAL',
                sourceRefId: 'obs-a',
                severity: 'AWAS',
                areaName: 'Padang',
                latitude: -0.9,
                attributes: expect.objectContaining({ critical: true, sea_level_anomaly_m: -0.4 }),
                lease,
            }),
        ]);
        expect(repository.checkpoint).toHaveBeenCalledWith(expect.anything(), false, lease);
    });

    it('processes critical records before ordinary records in a page', async () => {
        client.getObservations.mockResolvedValue({
            generatedAt: sourceTime,
            items: [{ ...observation, observation_id: 'ordinary', critical: false }, observation],
            nextCursor: null,
        });
        await poll();
        expect(
            hazards.upsertBatchAndEnqueue.mock.calls.flatMap(([items]) =>
                items.map((item: { sourceRefId: string }) => item.sourceRefId)
            )
        ).toEqual(['obs-a', 'ordinary']);
        expect(hazards.upsertBatchAndEnqueue.mock.calls[1][0][0].severity).toBe('NORMAL');
    });

    it('queues critical data before writing quarantine batches', async () => {
        client.getObservations.mockResolvedValue({
            generatedAt: sourceTime,
            items: [
                { ...observation, extra: 'x'.repeat(env.SENSOR_PANTAI_MAX_RECORD_BYTES) },
                { ...observation, observation_id: 'valid-critical' },
            ],
            nextCursor: null,
        });
        await poll();
        expect(repository.rejectBatch).toHaveBeenCalledTimes(1);
        expect(hazards.upsertBatchAndEnqueue.mock.invocationCallOrder[0]).toBeLessThan(
            repository.rejectBatch.mock.invocationCallOrder[0]
        );
    });

    it('splits repeated identities into sequential batches instead of blocking the page', async () => {
        client.getObservations.mockResolvedValue({
            generatedAt: sourceTime,
            items: [observation, observation],
            nextCursor: null,
        });
        await poll();
        expect(hazards.upsertBatchAndEnqueue).toHaveBeenCalledTimes(2);
        expect(repository.checkpoint).toHaveBeenCalled();
    });

    it.each([
        { critical: 'true' },
        { wave_height_m: -1 },
        { observed_at: 'yesterday' },
        { station_id: 'unknown' },
        { observed_at: '2026-11-13T00:00:00Z' },
    ])('quarantines invalid data while continuing valid records: %o', async (invalid) => {
        client.getObservations.mockResolvedValue({
            generatedAt: sourceTime,
            items: [
                { ...observation, ...invalid },
                { ...observation, observation_id: 'valid' },
            ],
            nextCursor: 'next',
        });
        client.getObservations
            .mockResolvedValueOnce({
                generatedAt: sourceTime,
                items: [
                    { ...observation, ...invalid },
                    { ...observation, observation_id: 'valid' },
                ],
                nextCursor: 'next',
            })
            .mockResolvedValueOnce({ generatedAt: sourceTime, items: [], nextCursor: null });
        await poll();
        expect(repository.rejectBatch).toHaveBeenCalledTimes(1);
        expect(hazards.upsertBatchAndEnqueue).toHaveBeenCalledTimes(1);
        expect(repository.checkpoint).toHaveBeenLastCalledWith(
            expect.objectContaining({ cursor: 'next' }),
            false,
            lease
        );
    });

    it('retains the last cursor on an empty EOF page', async () => {
        client.getObservations.mockResolvedValue({ generatedAt: sourceTime, items: [], nextCursor: null });
        await poll();
        expect(repository.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'saved' }), false, lease);
        expect(repository.recordFailure).not.toHaveBeenCalled();
    });

    it('refreshes station metadata before rejecting a newly introduced station', async () => {
        client.getStations.mockResolvedValue([station, { ...station, station_id: 'new-station', name: 'New Coast' }]);
        client.getObservations.mockResolvedValue({
            generatedAt: sourceTime,
            items: [{ ...observation, station_id: 'new-station' }],
            nextCursor: null,
        });
        await poll();
        expect(client.getStations).toHaveBeenCalledTimes(1);
        expect(repository.reject).not.toHaveBeenCalled();
        expect(hazards.upsertBatchAndEnqueue).toHaveBeenCalledWith([
            expect.objectContaining({ areaName: 'New Coast' }),
        ]);
    });

    it('does not advance the checkpoint when storing a record fails', async () => {
        hazards.upsertBatchAndEnqueue.mockRejectedValue(new Error('MongoDB temporarily unavailable'));
        await poll();
        expect(repository.checkpoint).not.toHaveBeenCalled();
        expect(repository.recordFailure).toHaveBeenCalled();
    });

    it('discards stale ownership without recording a source failure', async () => {
        hazards.upsertBatchAndEnqueue.mockRejectedValue(new LeaseLostError());
        await poll();
        expect(leadership.invalidate).toHaveBeenCalledWith(lease);
        expect(repository.recordFailure).not.toHaveBeenCalled();
        expect(repository.checkpoint).not.toHaveBeenCalled();
    });

    it('marks an unchanging generated_at stale even when HTTP succeeds', async () => {
        state.generatedAt = sourceTime;
        state.sourceProgressAt = new Date(now.getTime() - env.SENSOR_PANTAI_STALE_AFTER_MS - 1);
        await poll();
        expect(repository.checkpoint).toHaveBeenCalledWith(expect.anything(), true, lease);
    });

    it('marks old observations stale relative to the source clock at the tail', async () => {
        client.getObservations.mockResolvedValue({
            generatedAt: new Date(sourceTime.getTime() + env.SENSOR_PANTAI_MAX_SOURCE_LAG_MS + 1),
            items: [observation],
            nextCursor: null,
        });
        await poll();
        expect(repository.checkpoint).toHaveBeenCalledWith(expect.anything(), true, lease);
    });

    it('preserves malformed response bytes and retries without moving the cursor', async () => {
        client.getObservations.mockRejectedValue(new SensorClientError('bad JSON', undefined, 'base64-body'));
        await poll();
        expect(repository.reject).toHaveBeenCalledWith(
            { encoding: 'base64', body: 'base64-body', truncated: false },
            'bad JSON',
            expect.any(String),
            lease
        );
        expect(repository.checkpoint).not.toHaveBeenCalled();
    });

    it('passes Retry-After to the persistent circuit breaker', async () => {
        client.getObservations.mockRejectedValue(new SensorClientError('rate limited', 429, undefined, false, 3000));
        await poll();
        expect(repository.recordFailure).toHaveBeenCalledWith('rate limited', 3000, lease);
    });
});
