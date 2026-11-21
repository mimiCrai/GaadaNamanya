import 'reflect-metadata';
import { LeaseToken } from '../../src/db/schema/background-leases';
import { ProcessingError } from '../../src/libs/processing-error';
import { IBackgroundLeadershipService } from '../../src/services/background-leadership.service';
import { UnprocessedHandlerRegistry } from '../../src/services/unprocessed-handler.registry';
import { UnprocessedRetryService } from '../../src/services/unprocessed-retry.service';

import { FakeRepository, tick } from '../helpers/fake-unprocessed-repository';

function leadershipFor(token: LeaseToken): IBackgroundLeadershipService {
    return {
        instanceId: token.ownerId,
        start: jest.fn(),
        stop: jest.fn(),
        current: () => token,
        invalidate: jest.fn(),
        onChange: () => () => undefined,
    };
}

function registryWith(handler: (id: string) => Promise<void>) {
    const registry = new UnprocessedHandlerRegistry({
        reprocessVolcanicRecord: jest.fn(),
        reprocessVolcanicResponse: jest.fn(),
    } as never);
    registry.register('PVMBG', 'poll.volcanic-report', async (_raw, entry) => {
        await handler(entry.messageId);
        return { hazardId: `hz-${entry.messageId}` };
    });
    return registry;
}

describe('UnprocessedRetryService', () => {
    it('never lets two concurrent workers process the same entry', async () => {
        const repo = new FakeRepository();
        for (let i = 0; i < 50; i++) repo.add(`msg-${i}`);
        const processed = new Map<string, number>();
        const registry = registryWith(async (id) => {
            processed.set(id, (processed.get(id) ?? 0) + 1);
            await tick();
        });
        const a = new UnprocessedRetryService(repo, registry, leadershipFor({ ownerId: 'replica-a', epoch: 4 }));
        const b = new UnprocessedRetryService(repo, registry, leadershipFor({ ownerId: 'replica-b', epoch: 5 }));

        let claimed = 0;
        for (let round = 0; round < 10; round++) {
            const [ca, cb] = await Promise.all([a.runOnce(), b.runOnce()]);
            claimed += ca + cb;
        }

        expect(claimed).toBe(50);
        expect(processed.size).toBe(50);
        expect([...processed.values()].every((count) => count === 1)).toBe(true);
        expect([...repo.entries.values()].every((e) => e.status === 'recovered' && e.attempts === 2)).toBe(true);
    });

    it('takes over an entry whose claim expired (worker died after claiming)', async () => {
        const repo = new FakeRepository();
        repo.add('msg-dead', { claimedBy: 'replica-dead', claimEpoch: 3, claimedUntil: new Date(Date.now() + 60_000) });
        const seen: string[] = [];
        const worker = new UnprocessedRetryService(
            repo,
            registryWith(async (id) => void seen.push(id)),
            leadershipFor({ ownerId: 'replica-new', epoch: 4 })
        );

        expect(await worker.runOnce()).toBe(0); // claim still live: untouched
        repo.now = () => Date.now() + 61_000; // claim expired
        expect(await worker.runOnce()).toBe(1);
        expect(seen).toEqual(['msg-dead']);
        expect(repo.entries.get('msg-dead')!.status).toBe('recovered');
    });

    it('ignores a stale completion from a worker that lost its claim', async () => {
        const repo = new FakeRepository();
        repo.add('msg-slow');
        let release!: () => void;
        const registry = registryWith(() => new Promise<void>((resolve) => (release = resolve)));
        const slow = new UnprocessedRetryService(repo, registry, leadershipFor({ ownerId: 'old-leader', epoch: 1 }));
        const run = slow.runOnce();
        while (!release) await tick();
        // The claim expires and a new leader takes the entry while the old one is still running.
        const entry = repo.entries.get('msg-slow')!;
        Object.assign(entry, { claimedBy: 'new-leader', claimEpoch: 2 });
        release();
        await run;
        expect(entry.status).toBe('retrying');
        expect(entry.claimedBy).toBe('new-leader');
    });

    it('retries transient failures with backoff, parks permanent ones and exhausted ones', async () => {
        const repo = new FakeRepository();
        repo.add('msg-transient');
        repo.add('msg-permanent');
        repo.add('msg-exhausted', { attempts: 2 });
        const registry = registryWith(async (id) => {
            if (id === 'msg-permanent')
                throw new ProcessingError('schema_incompatible', "field 'level' berubah dari number menjadi string");
            throw new ProcessingError('upstream_unavailable', 'Aggregator membalas HTTP 503');
        });
        const worker = new UnprocessedRetryService(repo, registry, leadershipFor({ ownerId: 'leader', epoch: 1 }));
        await worker.runOnce();

        const transient = repo.entries.get('msg-transient')!;
        expect(transient.status).toBe('retrying');
        expect(transient.attempts).toBe(2);
        expect(transient.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
        expect(repo.entries.get('msg-permanent')!.status).toBe('parked');
        const exhausted = repo.entries.get('msg-exhausted')!;
        expect(exhausted.status).toBe('parked');
        expect(exhausted.reason).toMatch(/^retry_exhausted: percobaan habis setelah 3 kali/);
    });

    it('parks a replayed oversized body at once as payload_too_large instead of retrying it as unexpected', async () => {
        const repo = new FakeRepository();
        repo.add('msg-oversized', { sizeBytes: 12 * 1024 * 1024 });
        const handler = jest.fn(async () => undefined);
        const worker = new UnprocessedRetryService(repo, registryWith(handler), leadershipFor({ ownerId: 'leader', epoch: 1 }));
        await worker.runOnce();

        const entry = repo.entries.get('msg-oversized')!;
        expect(handler).not.toHaveBeenCalled();
        expect(entry.status).toBe('parked');
        expect(entry.retryable).toBe(false);
        expect(entry.reason).toBe('payload_too_large: ukuran 12582912 byte melebihi batas 5242880 byte');
    });

    it('parks entries without a registered handler and does nothing without the lease', async () => {
        const repo = new FakeRepository();
        repo.add('msg-unknown', {
            source: 'SATELIT',
            context: { kind: 'stream.detection', endpoint: null, topic: null },
        });
        const follower = new UnprocessedRetryService(
            repo,
            registryWith(async () => undefined),
            {
                ...leadershipFor({ ownerId: 'f', epoch: 1 }),
                current: () => null,
            }
        );
        expect(await follower.runOnce()).toBe(0);

        const leader = new UnprocessedRetryService(
            repo,
            registryWith(async () => undefined),
            leadershipFor({ ownerId: 'l', epoch: 1 })
        );
        await leader.runOnce();
        expect(repo.entries.get('msg-unknown')!.status).toBe('parked');
        expect(repo.entries.get('msg-unknown')!.reason).toBe(
            'handler_missing: tidak ada handler untuk SATELIT:stream.detection'
        );
    });
});
