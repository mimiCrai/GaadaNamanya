import 'reflect-metadata';
import { SourceStream, SourceSyncState, SourceSyncStatus } from '../../src/db/schema/source-sync-states';
import { ProcessingError } from '../../src/libs/processing-error';
import {
    backfillSkippedWindow,
    PVMBG_WINDOW_SKIPPED_KIND,
    PvmbgBodyFailureService,
    SourceBodyHeldError,
} from '../../src/services/pvmbg-body-failure.service';
import { UnprocessedHandlerRegistry } from '../../src/services/unprocessed-handler.registry';
import { PollingService } from '../../src/services/polling.service';
import { ISourceSyncStateService } from '../../src/services/source-sync-state.service';
import { IUnprocessedRecorder } from '../../src/services/unprocessed-recorder.service';
import env from '../../src/util/env';

const lease = { ownerId: 'leader', epoch: 3 };
const truncated = new ProcessingError('malformed_json', 'JSON terpotong (Unexpected end of JSON input)');
const since = new Date('2026-11-20T10:00:00.000Z');
const until = new Date('2026-11-20T10:00:03.000Z');

function stateWith(consecutiveFailures: number, consecutiveBodyFailures?: number): SourceSyncState {
    return {
        sourceStream: SourceStream.PvmbgVolcanic,
        status: SourceSyncStatus.Stale,
        lastSuccessfulPollAt: since,
        lastAttemptAt: until,
        staleSince: since,
        lastError: 'PVMBG returned HTTP 503',
        consecutiveFailures,
        consecutiveBodyFailures,
    };
}

describe('D-34 PVMBG body failures hold the checkpoint up to K polls', () => {
    let states: jest.Mocked<ISourceSyncStateService>;
    let recorder: jest.Mocked<IUnprocessedRecorder>;
    let service: PvmbgBodyFailureService;

    beforeEach(() => {
        states = {
            getPollingStatus: jest.fn(),
            getState: jest.fn(),
            recordSuccessfulPoll: jest.fn(),
            recordFailedPoll: jest.fn(),
            recordHeldBodyFailure: jest.fn().mockResolvedValue(1),
            recordSkippedWindow: jest.fn(),
        };
        recorder = {
            record: jest.fn().mockResolvedValue({ messageId: 'msg-x', created: true, reopened: false, status: 'parked' }),
        };
        service = new PvmbgBodyFailureService(states, recorder);
    });

    it('several outages followed by one broken body still hold (outages do not count toward K)', async () => {
        states.getState.mockResolvedValue(stateWith(env.PVMBG_BODY_FAILURE_HOLD_POLLS + 7, 0));

        await expect(service.onBodyFailure(truncated, { since, until, correlationId: 'c-1' }, lease)).rejects.toBeInstanceOf(
            SourceBodyHeldError
        );
        expect(states.recordHeldBodyFailure).toHaveBeenCalledWith(SourceStream.PvmbgVolcanic, lease);
        expect(recorder.record).not.toHaveBeenCalled();
    });

    it('a state written before D-34 (no counter) holds on the first broken body', async () => {
        states.getState.mockResolvedValue(stateWith(2));
        await expect(service.onBodyFailure(truncated, { since, until, correlationId: 'c-2' }, lease)).rejects.toThrow(
            /checkpoint ditahan/
        );
    });

    it('the K-th consecutive broken body records the skipped window as window_skipped (retryable, for backfill)', async () => {
        states.getState.mockResolvedValue(stateWith(0, env.PVMBG_BODY_FAILURE_HOLD_POLLS - 1));

        await expect(service.onBodyFailure(truncated, { since, until, correlationId: 'c-3' }, lease)).resolves.toEqual({
            messageId: 'msg-x',
            error: expect.objectContaining({ category: 'window_skipped', retryable: true }),
        });

        expect(states.recordHeldBodyFailure).not.toHaveBeenCalled();
        expect(recorder.record).toHaveBeenCalledTimes(1);
        const [input, usedLease] = recorder.record.mock.calls[0];
        expect(usedLease).toBe(lease);
        expect(input.context.kind).toBe(PVMBG_WINDOW_SKIPPED_KIND);
        expect(input.error.category).toBe('window_skipped');
        expect(input.error.retryable).toBe(true);
        expect(input.error.reason).toBe(
            `window_skipped: jendela poll [${since.toISOString()}, ${until.toISOString()}) dilewati setelah ${env.PVMBG_BODY_FAILURE_HOLD_POLLS} body rusak berturut-turut; diisi ulang retry worker dengan since=${since.toISOString()}`
        );
        const payload = JSON.parse((input.payload as { bytes: Buffer }).bytes.toString('utf8'));
        expect(payload).toEqual(
            expect.objectContaining({ since: since.toISOString(), until: until.toISOString(), last_failure: truncated.reason })
        );
    });

    it('PollingService keeps the checkpoint while held; at K it moves only the cursor and the source stays STALE (P1)', async () => {
        const leases = { requireActive: jest.fn(async () => until) };
        const pvmbg = {
            getVolcanicReports: jest.fn(async () => ({ records: [], contentType: 'application/json', failure: {} })),
        };
        const ingestion = { ingestVolcanicBatch: jest.fn(async () => ({ bodyFailure: truncated })) };
        const leadership = { current: jest.fn(() => lease), invalidate: jest.fn() };
        const poller = new PollingService(
            {} as never,
            pvmbg as never,
            ingestion as never,
            states,
            leadership as never,
            leases as never,
            service
        );
        (poller as unknown as { stopped: boolean }).stopped = false;
        const runPvmbg = () =>
            (
                poller as unknown as { runOnce(stream: SourceStream, work: unknown): Promise<void> }
            ).runOnce(SourceStream.PvmbgVolcanic, (options: never, l: never) =>
                (poller as unknown as { pollPvmbgVolcanic(o: never, l: never): Promise<void> }).pollPvmbgVolcanic(options, l)
            );

        states.getState.mockResolvedValue(stateWith(0, 0));
        await runPvmbg();
        expect(states.recordSuccessfulPoll).not.toHaveBeenCalled();
        expect(states.recordFailedPoll).toHaveBeenCalledWith(
            SourceStream.PvmbgVolcanic,
            expect.any(SourceBodyHeldError),
            until,
            lease
        );

        states.getState.mockResolvedValue(stateWith(1, env.PVMBG_BODY_FAILURE_HOLD_POLLS - 1));
        await runPvmbg();
        expect(recorder.record).toHaveBeenCalledTimes(1);
        // nothing valid was read: no HEALTHY, lastSuccessfulPollAt untouched, only the cursor moves
        expect(states.recordSuccessfulPoll).not.toHaveBeenCalled();
        expect(states.recordSkippedWindow).toHaveBeenCalledWith(
            SourceStream.PvmbgVolcanic,
            until,
            expect.objectContaining({ category: 'window_skipped' }),
            lease
        );

        // the next poll starts from the cursor (checkpointAt), not from the older lastSuccessfulPollAt
        ingestion.ingestVolcanicBatch.mockResolvedValueOnce({ bodyFailure: null } as never);
        states.getState.mockResolvedValue({ ...stateWith(1, 0), checkpointAt: until });
        await runPvmbg();
        expect(pvmbg.getVolcanicReports).toHaveBeenLastCalledWith(
            expect.objectContaining({ since: new Date(until.getTime() - env.POLL_OVERLAP_MS) })
        );
        expect(states.recordSuccessfulPoll).toHaveBeenCalledWith(SourceStream.PvmbgVolcanic, until, lease);
    });
});

describe('D-44 backfill of a skipped PVMBG window', () => {
    const entry = { messageId: 'msg-win', correlationId: 'c-win' };
    const windowBytes = (body: object) => Buffer.from(JSON.stringify(body));
    const valid = windowBytes({ source: 'PVMBG', since: since.toISOString(), until: until.toISOString() });
    const batch = { records: [{ raw: Buffer.from('{}'), value: {} }], contentType: 'application/json' };
    let pvmbg: { getVolcanicReports: jest.Mock };
    let ingestion: { ingestVolcanicBatch: jest.Mock };

    beforeEach(() => {
        pvmbg = { getVolcanicReports: jest.fn(async () => batch) };
        ingestion = { ingestVolcanicBatch: jest.fn(async () => ({ bodyFailure: null })) };
    });

    it('re-polls with the window since and ingests through the normal batch path', async () => {
        await expect(backfillSkippedWindow(valid, entry, lease, pvmbg as never, ingestion)).resolves.toEqual({ hazardId: null });
        expect(pvmbg.getVolcanicReports).toHaveBeenCalledWith(
            expect.objectContaining({ since, correlationId: 'c-win', instanceId: lease.ownerId, fencingToken: lease.epoch })
        );
        expect(ingestion.ingestVolcanicBatch).toHaveBeenCalledWith(batch, 'c-win', lease);
    });

    it('a still-broken body keeps the entry retrying (retryable window_skipped)', async () => {
        ingestion.ingestVolcanicBatch.mockResolvedValue({ bodyFailure: truncated });
        await expect(backfillSkippedWindow(valid, entry, lease, pvmbg as never, ingestion)).rejects.toMatchObject({
            category: 'window_skipped',
            retryable: true,
        });
    });

    it('a window without since (first poll ever) re-polls from the start', async () => {
        await backfillSkippedWindow(windowBytes({ since: null, until: until.toISOString() }), entry, lease, pvmbg as never, ingestion);
        expect(pvmbg.getVolcanicReports.mock.calls[0][0].since).toBeUndefined();
    });

    it('a payload without since/until is parked as validation_failed', async () => {
        await expect(backfillSkippedWindow(windowBytes({ until: 'x' }), entry, lease, pvmbg as never, ingestion)).rejects.toMatchObject({
            category: 'validation_failed',
            retryable: false,
        });
        expect(pvmbg.getVolcanicReports).not.toHaveBeenCalled();
    });

    describe('draining a window larger than one page', () => {
        // same rules as the mock: reported_at >= since, ordered by reported_at then report_id, at most `limit`
        const source = (count: number, stepMs = 10) =>
            Array.from({ length: count }, (_, index) => ({
                report_id: `r-${String(index).padStart(4, '0')}`,
                reported_at: new Date(since.getTime() + index * stepMs).toISOString(),
            }));
        const serve = (reports: { report_id: string; reported_at: string }[]) =>
            jest.fn(async (options: { since?: Date; limit?: number }) => ({
                contentType: 'application/json',
                records: reports
                    .filter((report) => !options.since || Date.parse(report.reported_at) >= options.since.getTime())
                    .slice(0, options.limit ?? 500)
                    .map((value) => ({ raw: Buffer.from(JSON.stringify(value)), value })),
            }));
        const ingested = () =>
            new Set(
                ingestion.ingestVolcanicBatch.mock.calls.flatMap(([page]) =>
                    (page as typeof batch).records.map((record) => (record.value as { report_id: string }).report_id)
                )
            );
        const wide = windowBytes({ since: since.toISOString(), until: new Date(since.getTime() + 60_000).toISOString() });

        it('pages until a short page: 501 records with a 500 page are all ingested', async () => {
            pvmbg.getVolcanicReports = serve(source(501));
            await backfillSkippedWindow(wide, entry, lease, pvmbg as never, ingestion, 500);
            expect(ingested().size).toBe(501);
            expect(pvmbg.getVolcanicReports).toHaveBeenCalledTimes(2);
            expect(pvmbg.getVolcanicReports.mock.calls[1][0]).toMatchObject({ limit: 500, since: new Date(since.getTime() + 499 * 10) });
        });

        it('stops once a page reaches until (later records belong to the normal poll)', async () => {
            pvmbg.getVolcanicReports = serve(source(50, 1_000));
            const narrow = windowBytes({ since: since.toISOString(), until: new Date(since.getTime() + 15_000).toISOString() });
            await backfillSkippedWindow(narrow, entry, lease, pvmbg as never, ingestion, 10);
            expect(pvmbg.getVolcanicReports).toHaveBeenCalledTimes(2);
            expect([...ingested()]).toEqual(expect.arrayContaining(source(16, 1_000).map((report) => report.report_id)));
        });

        it('a full page that cannot move the cursor keeps the entry retrying instead of closing it', async () => {
            pvmbg.getVolcanicReports = serve(source(6, 0));
            await expect(backfillSkippedWindow(wide, entry, lease, pvmbg as never, ingestion, 3)).rejects.toMatchObject({
                category: 'window_skipped',
                retryable: true,
            });
        });

        it('a broken body on a later page keeps the entry retrying', async () => {
            pvmbg.getVolcanicReports = serve(source(5));
            ingestion.ingestVolcanicBatch.mockResolvedValueOnce({ bodyFailure: null }).mockResolvedValueOnce({ bodyFailure: truncated });
            await expect(backfillSkippedWindow(wide, entry, lease, pvmbg as never, ingestion, 3)).rejects.toMatchObject({
                category: 'window_skipped',
            });
        });
    });

    it('the registry wires PVMBG:poll.window-skipped to the backfill when the PVMBG client is bound', () => {
        expect(new UnprocessedHandlerRegistry(ingestion as never).get('PVMBG', PVMBG_WINDOW_SKIPPED_KIND)).toBeUndefined();
        const registry = new UnprocessedHandlerRegistry(ingestion as never, undefined, pvmbg as never);
        expect(registry.get('PVMBG', PVMBG_WINDOW_SKIPPED_KIND)).toBeDefined();
        expect(registry.replayable()).toContainEqual({ source: 'PVMBG', kind: PVMBG_WINDOW_SKIPPED_KIND });
    });
});
