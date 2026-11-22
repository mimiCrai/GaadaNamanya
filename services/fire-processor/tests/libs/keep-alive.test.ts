import { keepAlive } from '../../src/libs/keep-alive';

describe('keepAlive (P4.4 heartbeats during long successful batches)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('heartbeats on every tick while a batch runs and stops when released', async () => {
        const heartbeat = jest.fn(async () => undefined);
        const stop = keepAlive(heartbeat, 1_000);
        await jest.advanceTimersByTimeAsync(3_500);
        expect(heartbeat).toHaveBeenCalledTimes(3);
        stop();
        await jest.advanceTimersByTimeAsync(5_000);
        expect(heartbeat).toHaveBeenCalledTimes(3);
    });

    it('never overlaps a slow heartbeat and swallows a rejected one', async () => {
        let release: () => void = () => undefined;
        const heartbeat = jest
            .fn<Promise<void>, []>()
            .mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
            .mockRejectedValue(new Error('rebalancing'));
        const stop = keepAlive(heartbeat, 1_000);
        await jest.advanceTimersByTimeAsync(3_000);
        expect(heartbeat).toHaveBeenCalledTimes(1);
        release();
        await jest.advanceTimersByTimeAsync(1_000);
        expect(heartbeat).toHaveBeenCalledTimes(2);
        stop();
    });
});
