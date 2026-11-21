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

export interface IUnprocessedReplayService {
    replay(filter: ReplayFilter, correlationId: string): Promise<ReplayResult>;
}

// chronological proxy per source_ref_id: receive order (seq, index), then receivedAt; correctness comes from the version guard
export function replayOrder(a: ReplayCandidate, b: ReplayCandidate): number {
    const key = (c: ReplayCandidate) => c.sourceRefId ?? '￿';
    return (
        key(a).localeCompare(key(b)) ||
        (a.ordering?.seq ?? 0) - (b.ordering?.seq ?? 0) ||
        (a.ordering?.index ?? -1) - (b.ordering?.index ?? -1) ||
        a.receivedAt.getTime() - b.receivedAt.getTime() ||
        a.messageId.localeCompare(b.messageId)
    );
}

/** Replay = requeue parked entries for the Tahap 1 retry worker (rule 9c); no second processing path. */
@injectable()
export class UnprocessedReplayService implements IUnprocessedReplayService {
    constructor(
        @inject(TYPES.IUnprocessedMessageRepository) private readonly repository: IUnprocessedMessageRepository,
        @inject(TYPES.IUnprocessedHandlerRegistry) private readonly registry: IUnprocessedHandlerRegistry
    ) {}

    async replay(filter: ReplayFilter, correlationId: string): Promise<ReplayResult> {
        const found = await this.repository.findReplayCandidates(filter, env.DLQ_REPLAY_MAX + 1);
        const truncated = found.length > env.DLQ_REPLAY_MAX;
        const candidates = found.slice(0, env.DLQ_REPLAY_MAX).sort(replayOrder);
        const skipped = new Map<ReplaySkipReason, string[]>();
        const skip = (reason: ReplaySkipReason, candidate: ReplayCandidate) => {
            skipped.set(reason, [...(skipped.get(reason) ?? []), candidate.messageId]);
            dlqReplayTotal.inc({ source: candidate.source, result: reason });
        };
        const note = `requeued: replay manual (status=${filter.status}${filter.source ? `, source=${filter.source}` : ''}${
            filter.category ? `, category=${filter.category}` : ''
        }${filter.reasonPrefix ? `, reason^=${filter.reasonPrefix}` : ''}; correlationId=${correlationId})`;

        let requeued = 0;
        for (const [rank, candidate] of candidates.entries()) {
            // e.g. SATELIT:stream.event (D-21) or PVMBG:poll.window-skipped: requeueing would only end in handler_missing
            if (!this.registry.get(candidate.source, candidate.kind)) {
                skip('handler_missing', candidate);
                continue;
            }
            if (candidate.status === 'retrying' && candidate.claimedUntil && candidate.claimedUntil.getTime() > Date.now()) {
                skip('claimed', candidate);
                continue;
            }
            if (await this.repository.requeue(candidate.messageId, filter.status, rank, note)) {
                requeued++;
                dlqReplayTotal.inc({ source: candidate.source, result: 'requeued' });
            } else {
                // claimed meanwhile (retrying) or no longer in the expected status
                skip(filter.status === 'retrying' ? 'claimed' : 'status_changed', candidate);
            }
        }

        const result: ReplayResult = {
            matched: candidates.length,
            requeued,
            truncated,
            skipped: [...skipped.entries()].map(([reason, ids]) => ({
                reason,
                count: ids.length,
                message_ids: ids.slice(0, 20),
            })),
        };
        logger.info({ filter, ...result, skipped: result.skipped.map(({ reason, count }) => ({ reason, count })), correlationId }, 'DLQ replay requested');
        return result;
    }
}
