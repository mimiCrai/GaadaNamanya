import 'reflect-metadata';
import { DlqGateway } from '../../src/services/dlq-gateway.service';
import env from '../../src/util/env';

describe('DlqGateway timeouts', () => {
    const fetchMock = jest.fn();
    let timeoutSpy: jest.SpyInstance;

    beforeEach(() => {
        fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({ matched: 0, requeued: 0, skipped: [] })));
        global.fetch = fetchMock as unknown as typeof fetch;
        timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    });
    afterEach(() => timeoutSpy.mockRestore());

    it('gives replay its own longer budget (a batch of CAS requeues) and keeps reads on the gateway timeout', async () => {
        const gateway = new DlqGateway();
        await gateway.replay({ source: 'PVMBG' }, 'corr-1');
        expect(timeoutSpy).toHaveBeenLastCalledWith(env.DLQ_REPLAY_TIMEOUT_MS);
        expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST', body: '{"source":"PVMBG"}' }));

        await gateway.list({ source: 'PVMBG' }, 'corr-2');
        expect(timeoutSpy).toHaveBeenLastCalledWith(env.BNPB_GATEWAY_TIMEOUT_MS);
        expect(env.DLQ_REPLAY_TIMEOUT_MS).toBeGreaterThan(env.BNPB_GATEWAY_TIMEOUT_MS);
    });
});
