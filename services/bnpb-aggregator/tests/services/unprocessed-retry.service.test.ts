import 'reflect-metadata';
import { LeaseToken } from '../../src/db/schema/background-leases';
import { UnprocessedMessage } from '../../src/db/schema/unprocessed-messages';
import { ProcessingError } from '../../src/libs/processing-error';
import {
    CompletionOutcome,
    IUnprocessedMessageRepository,
} from '../../src/repositories/unprocessed-message.repository';
import { IBackgroundLeadershipService } from '../../src/services/background-leadership.service';
import { UnprocessedHandlerRegistry } from '../../src/services/unprocessed-handler.registry';
import { UnprocessedRetryService } from '../../src/services/unprocessed-retry.service';

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** In-memory repository with the same compare-and-set semantics as the Mongo queries. */
class FakeRepository implements IUnprocessedMessageRepository {
    readonly entries = new Map<string, UnprocessedMessage>();
    now = () => Date.now();

    add(id: string, overrides: Partial<UnprocessedMessage> = {}) {
        this.entries.set(id, {
            messageId: id,
            source: 'PVMBG',
            context: { kind: 'poll.volcanic-report', endpoint: null, topic: null },
            receivedAt: new Date(0),
            lastSeenAt: new Date(0),
            seenCount: 1,
            reason: 'store_unavailable: x',
            category: 'store_unavailable',
            retryable: true,
            attempts: 1,
            maxAttempts: 3,
            status: 'retrying',
            nextAttemptAt: new Date(0),
            claimedBy: null,
            claimEpoch: null,
            claimedUntil: null,
            payload: null,
            payloadRef: null,
            contentType: 'application/json',
            sizeBytes: 2,
            sha256: 'x',
            correlationId: 'c',
            sourceRefId: id,
            recoveredAt: null,
            recoveredHazardId: null,
            history: [],
            ...overrides,
        });
    }

    async record(): Promise<never> {
        throw new Error('unused');
    }
    async findDueIds(limit: number) {
        await tick();
        const now = this.now();
        return [...this.entries.values()]
            .filter(
                (e) =>
                    e.status === 'retrying' &&
                    e.nextAttemptAt!.getTime() <= now &&
                    (!e.claimedUntil || e.claimedUntil.getTime() <= now)
            )
            .slice(0, limit)
            .map((e) => e.messageId);
    }
    async claim(id: string, owner: string, epoch: number) {
        await tick();
        // check-and-set without awaiting in between = atomic, like findOneAndUpdate
        const e = this.entries.get(id);
        const now = this.now();
        if (!e || e.status !== 'retrying' || e.nextAttemptAt!.getTime() > now) return null;
        if (e.claimedUntil && e.claimedUntil.getTime() > now) return null;
        Object.assign(e, { claimedBy: owner, claimEpoch: epoch, claimedUntil: new Date(now + 30_000) });
        return { ...e };
    }
    async complete(entry: UnprocessedMessage, _lease: LeaseToken, outcome: CompletionOutcome) {
        await tick();
        const e = this.entries.get(entry.messageId)!;
        if (e.status !== 'retrying' || e.claimedBy !== entry.claimedBy || e.claimEpoch !== entry.claimEpoch)
            return false;
        e.attempts++;
        Object.assign(e, { claimedBy: null, claimEpoch: null, claimedUntil: null });
        if (outcome.kind === 'recovered')
            Object.assign(e, { status: 'recovered', recoveredHazardId: outcome.hazardId });
        else if (outcome.kind === 'parked')
            Object.assign(e, { status: 'parked', retryable: false, reason: outcome.error.reason });
        else Object.assign(e, { nextAttemptAt: new Date(this.now() + outcome.delayMs), reason: outcome.error.reason });
        return true;
    }
    async findById(id: string) {
        return this.entries.get(id) ?? null;
    }
    async readPayload() {
        return Buffer.from('{}');
    }
    async countByStatus() {
        return [];
    }
}

function leadershipFor(token: LeaseToken): IBackgroundLeadershipService {
    return {
        instanceId: token.ownerId,
        start: jest.fn(),
        stop: jest.fn(),
        current: () => token,
        invalidate: jest.fn(),
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
