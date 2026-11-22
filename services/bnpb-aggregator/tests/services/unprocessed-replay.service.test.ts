import 'reflect-metadata';
import { LeaseToken } from '../../src/db/schema/background-leases';
import { ProcessingError } from '../../src/libs/processing-error';
import { IBackgroundLeadershipService } from '../../src/services/background-leadership.service';
import { UnprocessedHandlerRegistry } from '../../src/services/unprocessed-handler.registry';
import { UnprocessedReplayService } from '../../src/services/unprocessed-replay.service';
import { UnprocessedRetryService } from '../../src/services/unprocessed-retry.service';
import env from '../../src/util/env';
import { FakeRepository } from '../helpers/fake-unprocessed-repository';

const lease: LeaseToken = { ownerId: 'leader', epoch: 4 };
const leadership: IBackgroundLeadershipService = {
    instanceId: 'leader',
    start: jest.fn(),
    stop: jest.fn(),
    current: () => lease,
    invalidate: jest.fn(),
    onChange: () => () => undefined,
};

function parked(repo: FakeRepository, id: string, overrides: Parameters<FakeRepository['add']>[1] = {}) {
    repo.add(id, {
        status: 'parked',
        retryable: false,
        category: 'schema_incompatible',
        reason: "schema_incompatible: field wajib 'alert_level' hilang (kemungkinan di-rename menjadi 'level')",
        attempts: 1,
        nextAttemptAt: null,
        ...overrides,
    });
}

describe('UnprocessedReplayService (D-37): replay = requeue for the Tahap 1 retry worker', () => {
    let repo: FakeRepository;
    let registry: UnprocessedHandlerRegistry;
    let outcome: (id: string) => Promise<{ hazardId: string | null }>;

    beforeEach(() => {
        repo = new FakeRepository();
        registry = new UnprocessedHandlerRegistry({ reprocessVolcanicRecord: jest.fn(), reprocessVolcanicResponse: jest.fn() } as never);
        outcome = async (id) => ({ hazardId: `hz-${id}` });
        registry.register('PVMBG', 'poll.volcanic-report', (_raw, entry) => outcome(entry.messageId));
    });

    const replay = (filter: Partial<Parameters<UnprocessedReplayService['replay']>[0]> = {}) =>
        new UnprocessedReplayService(repo, registry).replay({ status: 'parked', ...filter }, 'corr-1');
    const worker = () => new UnprocessedRetryService(repo, registry, leadership);

    it('requeues parked entries with attempts reset and one history entry, and skips entries without a handler', async () => {
        parked(repo, 'msg-a');
        parked(repo, 'msg-sat', { source: 'SATELIT', context: { kind: 'stream.event', endpoint: null, topic: null } });
        parked(repo, 'msg-win', {
            context: { kind: 'poll.window-skipped', endpoint: null, topic: null },
            category: 'window_skipped',
            reason: 'window_skipped: jendela poll',
        });
        repo.add('msg-retrying');

        const result = await replay();

        expect(result).toEqual({
            matched: 3,
            requeued: 1,
            truncated: false,
            skipped: [{ reason: 'handler_missing', count: 2, message_ids: expect.arrayContaining(['msg-sat', 'msg-win']) }],
        });
        const entry = repo.entries.get('msg-a')!;
        expect(entry).toEqual(expect.objectContaining({ status: 'retrying', attempts: 0, claimedBy: null }));
        expect(entry.history.at(-1)!.reason).toMatch(/^requeued: replay manual \(status=parked; correlationId=corr-1\)$/);
        expect(repo.entries.get('msg-sat')!.status).toBe('parked');
        expect(repo.entries.get('msg-win')!.status).toBe('parked');
    });

    it('the worker turns successes into recovered and failures back into parked with the newest reason', async () => {
        parked(repo, 'msg-ok');
        parked(repo, 'msg-still-bad');
        outcome = async (id) => {
            if (id === 'msg-still-bad') throw new ProcessingError('validation_failed', "volcano_id 'X' tidak ada di tabel referensi BNPB");
            return { hazardId: `hz-${id}` };
        };

        await replay();
        // requeue spaces entries 1 ms apart: run the worker once all of them are due
        repo.now = () => Date.now() + 1_000;
        await worker().runOnce();

        expect(repo.entries.get('msg-ok')).toEqual(expect.objectContaining({ status: 'recovered', recoveredHazardId: 'hz-msg-ok' }));
        expect(repo.entries.get('msg-still-bad')).toEqual(
            expect.objectContaining({
                status: 'parked',
                reason: "validation_failed: volcano_id 'X' tidak ada di tabel referensi BNPB",
            })
        );
    });

    it('is idempotent: a second replay finds nothing once the first one has been processed', async () => {
        parked(repo, 'msg-a');
        await replay();
        await worker().runOnce();
        expect((await replay()).requeued).toBe(0);
        expect(repo.entries.get('msg-a')!.status).toBe('recovered');
    });

    it('filters by source, category and reason prefix', async () => {
        parked(repo, 'msg-schema');
        parked(repo, 'msg-value', { category: 'validation_failed', reason: 'validation_failed: x' });
        parked(repo, 'msg-bmkg', { source: 'BMKG' });
        expect((await replay({ source: 'PVMBG', category: 'validation_failed' })).requeued).toBe(1);
        expect(repo.entries.get('msg-value')!.status).toBe('retrying');
        expect((await replay({ reasonPrefix: 'schema_incompatible: field wajib' })).requeued).toBe(1);
        expect(repo.entries.get('msg-bmkg')!.status).toBe('parked');
    });

    it('status=retrying only when asked; entries being processed (claimed) or already requeued are not selected', async () => {
        repo.add('msg-free');
        repo.add('msg-claimed', { claimedBy: 'other', claimEpoch: 3, claimedUntil: new Date(Date.now() + 60_000) });
        expect((await replay()).matched).toBe(0);
        const result = await replay({ status: 'retrying' });
        expect(result).toEqual(expect.objectContaining({ matched: 1, requeued: 1, skipped: [] }));
        expect(repo.entries.get('msg-claimed')!.claimedBy).toBe('other');
        // msg-free now waits for the worker with attempts 0: a repeated call moves past it instead of requeueing it again
        expect((await replay({ status: 'retrying' })).matched).toBe(0);
    });

    it('spaces nextAttemptAt in chronological order per source_ref_id (seq, index, receivedAt)', async () => {
        parked(repo, 'msg-r2-late', { sourceRefId: 'VR-2', ordering: { seq: 9, index: 0 } });
        parked(repo, 'msg-r1-late', { sourceRefId: 'VR-1', ordering: { seq: 7, index: 1 } });
        parked(repo, 'msg-r1-early', { sourceRefId: 'VR-1', ordering: { seq: 7, index: 0 } });
        parked(repo, 'msg-body', { sourceRefId: null, ordering: { seq: 1, index: null } });
        await replay();
        const order = [...repo.entries.values()]
            .sort((a, b) => a.nextAttemptAt!.getTime() - b.nextAttemptAt!.getTime() || 0)
            .map((e) => e.messageId);
        // whole-body entries have no source_ref_id and sort first, as Mongo sorts null
        expect(order).toEqual(['msg-body', 'msg-r1-early', 'msg-r1-late', 'msg-r2-late']);
    });

    describe('D-45: selection and order are applied before the limit (review P2)', () => {
        const max = env.DLQ_REPLAY_MAX;
        afterEach(() => {
            env.DLQ_REPLAY_MAX = max;
        });

        it('entries without a handler never take the slots of a replayable entry', async () => {
            env.DLQ_REPLAY_MAX = 2;
            parked(repo, 'msg-sat-1', { source: 'SATELIT', context: { kind: 'stream.event', endpoint: null, topic: null } });
            parked(repo, 'msg-sat-2', { source: 'SATELIT', context: { kind: 'stream.event', endpoint: null, topic: null } });
            parked(repo, 'msg-valid');

            for (let i = 0; i < 2; i++) {
                const result = await replay();
                expect(result.skipped).toEqual([{ reason: 'handler_missing', count: 2, message_ids: ['msg-sat-1', 'msg-sat-2'] }]);
                if (i === 0) expect(result).toEqual(expect.objectContaining({ requeued: 1, truncated: false }));
            }
            expect(repo.entries.get('msg-valid')!.status).toBe('retrying');
        });

        it('three versions of one source_ref_id: the oldest are queued first even when the newest is stored first', async () => {
            env.DLQ_REPLAY_MAX = 2;
            parked(repo, 'msg-v3', { sourceRefId: 'VR-1', ordering: { seq: 30, index: 0 } });
            parked(repo, 'msg-v2', { sourceRefId: 'VR-1', ordering: { seq: 20, index: 0 } });
            parked(repo, 'msg-v1', { sourceRefId: 'VR-1', ordering: { seq: 10, index: 0 } });

            const first = await replay();
            expect(first).toEqual(expect.objectContaining({ requeued: 2, truncated: true }));
            expect(repo.entries.get('msg-v3')!.status).toBe('parked');
            expect(repo.entries.get('msg-v1')!.nextAttemptAt!.getTime()).toBeLessThan(repo.entries.get('msg-v2')!.nextAttemptAt!.getTime());

            expect((await replay()).requeued).toBe(1);
            expect(repo.entries.get('msg-v3')!.status).toBe('retrying');
        });

        it('a truncated batch stops at a source_ref_id boundary instead of splitting the group', async () => {
            env.DLQ_REPLAY_MAX = 2;
            parked(repo, 'msg-a', { sourceRefId: 'VR-A', ordering: { seq: 1, index: 0 } });
            parked(repo, 'msg-b1', { sourceRefId: 'VR-B', ordering: { seq: 2, index: 0 } });
            parked(repo, 'msg-b2', { sourceRefId: 'VR-B', ordering: { seq: 3, index: 0 } });

            const first = await replay();
            expect(first).toEqual(expect.objectContaining({ matched: 1, requeued: 1, truncated: true }));
            expect(repo.entries.get('msg-b1')!.status).toBe('parked');
            expect((await replay()).requeued).toBe(2);
        });
    });
});
