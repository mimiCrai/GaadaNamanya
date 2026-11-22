import { LeaseToken } from '../../src/db/schema/background-leases';
import { UnprocessedMessage } from '../../src/db/schema/unprocessed-messages';
import {
    CompletionOutcome,
    IUnprocessedMessageRepository,
    ReplayableKind,
    ReplayCandidate,
    ReplayFilter,
    UnreplayableCount,
} from '../../src/repositories/unprocessed-message.repository';
import { replayOrder } from '../../src/services/unprocessed-replay.service';

export const tick = () => new Promise((resolve) => setImmediate(resolve));

/** In-memory repository with the same compare-and-set semantics as the Mongo queries. */
export class FakeRepository implements IUnprocessedMessageRepository {
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
        else if (outcome.kind === 'superseded')
            Object.assign(e, { status: 'superseded', recoveredHazardId: outcome.hazardId });
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
    // same selection as replayQuery + REPLAY_SORT: handler, claim and order are applied before the limit
    private replayMatches(filter: ReplayFilter, e: UnprocessedMessage) {
        return (
            e.status === filter.status &&
            (!filter.source || e.source === filter.source) &&
            (!filter.category || e.category === filter.category) &&
            (!filter.reasonPrefix || e.reason.startsWith(filter.reasonPrefix))
        );
    }
    private handled(replayable: ReplayableKind[], e: UnprocessedMessage) {
        return replayable.some((k) => k.source === e.source && k.kind === e.context.kind);
    }
    async findReplayCandidates(
        filter: ReplayFilter,
        replayable: ReplayableKind[],
        limit: number
    ): Promise<ReplayCandidate[]> {
        await tick();
        const now = this.now();
        return [...this.entries.values()]
            .filter(
                (e) =>
                    this.replayMatches(filter, e) &&
                    this.handled(replayable, e) &&
                    (filter.status !== 'retrying' ||
                        (e.attempts > 0 && (!e.claimedUntil || e.claimedUntil.getTime() <= now)))
            )
            .map((e) => ({
                messageId: e.messageId,
                source: e.source,
                kind: e.context.kind,
                status: e.status,
                sourceRefId: e.sourceRefId,
                ordering: e.ordering ?? null,
                receivedAt: e.receivedAt,
                claimedUntil: e.claimedUntil,
            }))
            .sort(replayOrder)
            .slice(0, limit);
    }
    async countUnreplayable(
        filter: ReplayFilter,
        replayable: ReplayableKind[],
        sampleSize: number
    ): Promise<UnreplayableCount[]> {
        await tick();
        const bySource = new Map<string, string[]>();
        for (const e of this.entries.values()) {
            if (!this.replayMatches(filter, e) || this.handled(replayable, e)) continue;
            bySource.set(e.source, [...(bySource.get(e.source) ?? []), e.messageId]);
        }
        return [...bySource.entries()].map(([source, ids]) => ({
            source,
            count: ids.length,
            messageIds: ids.sort().slice(0, sampleSize),
        }));
    }
    async requeue(id: string, expected: ReplayFilter['status'], delayMs: number, note: string) {
        await tick();
        const e = this.entries.get(id);
        const now = this.now();
        if (!e || e.status !== expected) return false;
        if (expected === 'retrying' && e.claimedUntil && e.claimedUntil.getTime() > now) return false;
        Object.assign(e, {
            status: 'retrying',
            attempts: 0,
            nextAttemptAt: new Date(now + delayMs),
            claimedBy: null,
            claimEpoch: null,
            claimedUntil: null,
        });
        e.history = [...e.history, { at: new Date(now), attempt: 0, reason: note, retryable: e.retryable }];
        return true;
    }
}
