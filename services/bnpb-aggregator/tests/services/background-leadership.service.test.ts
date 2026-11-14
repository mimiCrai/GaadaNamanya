import { BackgroundLeadershipService } from '../../src/services/background-leadership.service';
import { IBackgroundLeaseRepository } from '../../src/repositories/background-lease.repository';

describe('BackgroundLeadershipService', () => {
    const leases = { acquireOrRenew: jest.fn(), release: jest.fn() };
    let service: BackgroundLeadershipService;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.resetAllMocks();
        leases.release.mockResolvedValue(undefined);
        service = new BackgroundLeadershipService(leases as unknown as IBackgroundLeaseRepository);
    });

    afterEach(async () => {
        await service.stop();
        jest.useRealTimers();
    });

    it('disables work until the database grants leadership', async () => {
        leases.acquireOrRenew.mockResolvedValue(null);
        service.start();
        await jest.advanceTimersByTimeAsync(0);
        expect(service.current()).toBeNull();
        expect(leases.acquireOrRenew).toHaveBeenCalledWith(service.instanceId);
    });

    it('keeps one renewal loop and releases the current epoch on shutdown', async () => {
        leases.acquireOrRenew.mockResolvedValue({ epoch: 3 });
        service.start();
        service.start();
        await jest.advanceTimersByTimeAsync(0);
        expect(leases.acquireOrRenew).toHaveBeenCalledTimes(1);
        const token = service.current();
        expect(token).toEqual({ ownerId: service.instanceId, epoch: 3 });
        await service.stop();
        expect(service.current()).toBeNull();
        expect(leases.release).toHaveBeenCalledWith(token);
        await jest.advanceTimersByTimeAsync(10_000);
        expect(leases.acquireOrRenew).toHaveBeenCalledTimes(1);
    });

    it('fails closed when ownership verification fails', async () => {
        leases.acquireOrRenew.mockResolvedValueOnce({ epoch: 3 }).mockRejectedValue(new Error('database unavailable'));
        service.start();
        await jest.advanceTimersByTimeAsync(0);
        expect(service.current()?.epoch).toBe(3);
        await jest.advanceTimersByTimeAsync(2000);
        expect(service.current()).toBeNull();
    });

    it('does not let a delayed old task invalidate a newer grant', async () => {
        leases.acquireOrRenew.mockResolvedValueOnce({ epoch: 3 }).mockResolvedValue({ epoch: 4 });
        service.start();
        await jest.advanceTimersByTimeAsync(0);
        const old = service.current()!;
        await jest.advanceTimersByTimeAsync(2000);
        service.invalidate(old);
        expect(service.current()?.epoch).toBe(4);
        service.invalidate(service.current()!);
        expect(service.current()).toBeNull();
    });
});
