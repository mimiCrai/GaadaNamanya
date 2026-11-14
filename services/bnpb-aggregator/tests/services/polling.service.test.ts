import { PollingService } from '../../src/services/polling.service';
import { LeaseLostError } from '../../src/db/schema/background-leases';
import { IBmkgClient } from '../../src/clients/bmkg.client';
import { IPvmbgClient } from '../../src/clients/pvmbg.client';
import { IHazardEventIngestionService } from '../../src/services/hazard-event-ingestion.service';
import { ISourceSyncStateService } from '../../src/services/source-sync-state.service';
import { IBackgroundLeadershipService } from '../../src/services/background-leadership.service';
import { IBackgroundLeaseRepository } from '../../src/repositories/background-lease.repository';

describe('Fenced source polling', () => {
    const lease = { ownerId: 'test-owner', epoch: 7 };
    const serverTime = new Date('2026-01-01T01:00:00Z');
    const bmkg = { getSeismicEvents: jest.fn(), getTsunamiWarnings: jest.fn() };
    const pvmbg = { getVolcanicReports: jest.fn() };
    const ingestion = {
        ingestSeismicEvents: jest.fn(),
        ingestTsunamiWarnings: jest.fn(),
        ingestVolcanicReports: jest.fn(),
    };
    const states = { getState: jest.fn(), recordSuccessfulPoll: jest.fn(), recordFailedPoll: jest.fn() };
    const leadership = { current: jest.fn(), invalidate: jest.fn() };
    const leases = { requireActive: jest.fn() };
    let poller: PollingService;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetAllMocks();
        leadership.current.mockReturnValue(lease);
        leases.requireActive.mockResolvedValue(serverTime);
        states.getState.mockResolvedValue(undefined);
        bmkg.getSeismicEvents.mockResolvedValue([]);
        bmkg.getTsunamiWarnings.mockResolvedValue([]);
        pvmbg.getVolcanicReports.mockResolvedValue([]);
        poller = new PollingService(
            bmkg as IBmkgClient,
            pvmbg as IPvmbgClient,
            ingestion as IHazardEventIngestionService,
            states as unknown as ISourceSyncStateService,
            leadership as unknown as IBackgroundLeadershipService,
            leases as unknown as IBackgroundLeaseRepository
        );
    });
    afterEach(() => {
        poller.stop();
        jest.useRealTimers();
    });

    it('keeps followers from calling any upstream', async () => {
        leadership.current.mockReturnValue(null);
        poller.start();
        await jest.advanceTimersByTimeAsync(0);
        expect(bmkg.getSeismicEvents).not.toHaveBeenCalled();
        expect(bmkg.getTsunamiWarnings).not.toHaveBeenCalled();
        expect(pvmbg.getVolcanicReports).not.toHaveBeenCalled();
    });

    it('passes the captured epoch through ingestion and checkpoints the database time before the request', async () => {
        poller.start();
        await jest.advanceTimersByTimeAsync(0);
        expect(ingestion.ingestSeismicEvents).toHaveBeenCalledWith([], expect.any(String), lease);
        expect(states.recordSuccessfulPoll).toHaveBeenCalledWith('BMKG_SEISMIC', serverTime, lease);
        expect(bmkg.getSeismicEvents).toHaveBeenCalledWith(
            expect.objectContaining({ instanceId: lease.ownerId, fencingToken: 7 })
        );
    });

    it('does not call upstreams after a stale epoch fails its database gate', async () => {
        leases.requireActive.mockRejectedValue(new LeaseLostError());
        poller.start();
        await jest.advanceTimersByTimeAsync(0);
        expect(bmkg.getSeismicEvents).not.toHaveBeenCalled();
        expect(states.recordFailedPoll).not.toHaveBeenCalled();
        expect(leadership.invalidate).toHaveBeenCalledWith(lease);
    });

    it('does not advance checkpoints or mark sources stale when ingestion is fenced out', async () => {
        ingestion.ingestSeismicEvents.mockRejectedValue(new LeaseLostError());
        poller.start();
        await jest.advanceTimersByTimeAsync(0);
        expect(states.recordSuccessfulPoll.mock.calls.some(([stream]) => stream === 'BMKG_SEISMIC')).toBe(false);
        expect(states.recordFailedPoll).not.toHaveBeenCalled();
        expect(leadership.invalidate).toHaveBeenCalledWith(lease);
    });
});
