import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { logger } from '../libs/logger';
import { dlqReplayTotal } from '../libs/metrics';
import { IUnprocessedMessageRepository, ReplayCandidate, ReplayFilter } from '../repositories/unprocessed-message.repository';
import env from '../util/env';
import { IUnprocessedHandlerRegistry } from './unprocessed-handler.registry';

export type ReplaySkipReason = 'handler_missing' | 'claimed' | 'status_changed';

export interface ReplayResult {
    matched: number;
    requeued: number;
    truncated: boolean;
    skipped: { reason: ReplaySkipReason; count: number; message_ids: string[] }[];
}

const SKIPPED_SAMPLE = 20;

export interface IUnprocessedReplayService {
    replay(filter: ReplayFilter, correlationId: string): Promise<ReplayResult>;
}

// Same order as REPLAY_SORT in Mongo (nulls first, binary string compare); correctness comes from the version guard
export function replayOrder(a: ReplayCandidate, b: ReplayCandidate): number {
    return (
        compareNullable(a.sourceRefId, b.sourceRefId) ||
        compareNullable(a.ordering?.seq, b.ordering?.seq) ||
        compareNullable(a.ordering?.index, b.ordering?.index) ||
        a.receivedAt.getTime() - b.receivedAt.getTime() ||
        compareNullable(a.messageId, b.messageId)
    );
}

// a truncated batch never splits one source_ref_id, so a later replay cannot queue its newer versions ahead of older ones
export function withinGroupBoundary(sorted: ReplayCandidate[], max: number): ReplayCandidate[] {
    const head = sorted.slice(0, max);
    const cut = sorted[max]?.sourceRefId;
    if (cut == null) return head;
    const kept = head.filter((candidate) => candidate.sourceRefId !== cut);
    return kept.length ? kept : head;
}

function compareNullable<T extends string | number>(a: T | null | undefined, b: T | null | undefined): number {
    if (a == null || b == null) return a == null ? (b == null ? 0 : -1) : 1;
    return a < b ? -1 : a > b ? 1 : 0;
}

/** Replay = requeue parked entries for the Tahap 1 retry worker (rule 9c); no second processing path. */
@injectable()
export class UnprocessedReplayService implements IUnprocessedReplayService {
    constructor(
        @inject(TYPES.IUnprocessedMessageRepository) private readonly repository: IUnprocessedMessageRepository,
        @inject(TYPES.IUnprocessedHandlerRegistry) private readonly registry: IUnprocessedHandlerRegistry
    ) {}

    async replay(filter: ReplayFilter, correlationId: string): Promise<ReplayResult> {
        // D-45: handler selection, claim check and ordering happen in the query, before the limit
        const replayable = this.registry.replayable();
        const [found, unreplayable] = await Promise.all([
            this.repository.findReplayCandidates(filter, replayable, env.DLQ_REPLAY_MAX + 1),
            this.repository.countUnreplayable(filter, replayable, SKIPPED_SAMPLE),
        ]);
        const truncated = found.length > env.DLQ_REPLAY_MAX;
        const candidates = withinGroupBoundary(found.sort(replayOrder), env.DLQ_REPLAY_MAX);
        const skipped = new Map<ReplaySkipReason, { count: number; ids: string[] }>();
        const skip = (reason: ReplaySkipReason, source: string, ids: string[], count = ids.length) => {
            const current = skipped.get(reason) ?? { count: 0, ids: [] };
            skipped.set(reason, { count: current.count + count, ids: [...current.ids, ...ids] });
            dlqReplayTotal.inc({ source, result: reason }, count);
        };
        // e.g. SATELIT:stream.event (D-21): requeueing would only end in handler_missing
        for (const row of unreplayable) skip('handler_missing', row.source, row.messageIds, row.count);
        const note = `requeued: replay manual (status=${filter.status}${filter.source ? `, source=${filter.source}` : ''}${
            filter.category ? `, category=${filter.category}` : ''
        }${filter.reasonPrefix ? `, reason^=${filter.reasonPrefix}` : ''}; correlationId=${correlationId})`;

        let requeued = 0;
        for (const [rank, candidate] of candidates.entries()) {
            if (await this.repository.requeue(candidate.messageId, filter.status, rank, note)) {
                requeued++;
                dlqReplayTotal.inc({ source: candidate.source, result: 'requeued' });
            } else {
                // claimed meanwhile (retrying) or no longer in the expected status
                skip(filter.status === 'retrying' ? 'claimed' : 'status_changed', candidate.source, [candidate.messageId]);
            }
        }

        const unreplayableCount = unreplayable.reduce((sum, row) => sum + row.count, 0);
        const result: ReplayResult = {
            matched: candidates.length + unreplayableCount,
            requeued,
            truncated,
            skipped: [...skipped.entries()].map(([reason, { count, ids }]) => ({
                reason,
                count,
                message_ids: ids.slice(0, SKIPPED_SAMPLE),
            })),
        };
        logger.info({ filter, ...result, skipped: result.skipped.map(({ reason, count }) => ({ reason, count })), correlationId }, 'DLQ replay requested');
        return result;
    }
}
