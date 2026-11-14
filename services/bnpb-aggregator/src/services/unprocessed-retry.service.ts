import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { LeaseLostError, LeaseToken } from '../db/schema/background-leases';
import { UnprocessedMessage } from '../db/schema/unprocessed-messages';
import { computeBackoffMs } from '../libs/backoff';
import { logger } from '../libs/logger';
import { unprocessedRetryTotal } from '../libs/metrics';
import { classifyError, ProcessingError } from '../libs/processing-error';
import { CompletionOutcome, IUnprocessedMessageRepository } from '../repositories/unprocessed-message.repository';
import env from '../util/env';
import { IBackgroundLeadershipService } from './background-leadership.service';
import { IUnprocessedHandlerRegistry } from './unprocessed-handler.registry';

export interface IUnprocessedRetryService {
    start(): void;
    stop(): void;
    runOnce(): Promise<number>;
}

export interface RetryPolicy {
    maxAttempts: number;
    baseMs: number;
    capMs: number;
}

export function decideFailureOutcome(
    attemptsSoFar: number,
    error: ProcessingError,
    policy: RetryPolicy,
    random: () => number = Math.random
): CompletionOutcome {
    if (!error.retryable) return { kind: 'parked', error };
    const attempt = attemptsSoFar + 1;
    if (attempt >= policy.maxAttempts) {
        return {
            kind: 'parked',
            error: new ProcessingError(
                'retry_exhausted',
                `percobaan habis setelah ${attempt} kali; galat terakhir: ${error.reason}`
            ),
        };
    }
    return { kind: 'retry', error, delayMs: computeBackoffMs(attempt + 1, policy.baseMs, policy.capMs, random) };
}

@injectable()
export class UnprocessedRetryService implements IUnprocessedRetryService {
    private timer: NodeJS.Timeout | undefined;
    private running = false;
    private stopped = true;
    private stopRequested = false;

    constructor(
        @inject(TYPES.IUnprocessedMessageRepository) private readonly repository: IUnprocessedMessageRepository,
        @inject(TYPES.IUnprocessedHandlerRegistry) private readonly registry: IUnprocessedHandlerRegistry,
        @inject(TYPES.IBackgroundLeadershipService) private readonly leadership: IBackgroundLeadershipService
    ) {}

    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        this.stopRequested = false;
        this.schedule(env.DLQ_RETRY_INTERVAL_MS);
        logger.info({ handlers: this.registry.keys() }, 'Unprocessed message retry worker started');
    }

    stop(): void {
        this.stopped = true;
        this.stopRequested = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }

    private schedule(delayMs: number): void {
        this.timer = setTimeout(() => void this.tick(), delayMs);
    }

    private async tick(): Promise<void> {
        this.timer = undefined;
        if (this.stopped || this.running) return;
        this.running = true;
        try {
            await this.runOnce();
        } catch (error) {
            logger.error({ error }, 'Unprocessed retry pass failed; will retry next interval');
        } finally {
            this.running = false;
            if (!this.stopped) this.schedule(env.DLQ_RETRY_INTERVAL_MS);
        }
    }

    async runOnce(): Promise<number> {
        const lease = this.leadership.current();
        if (!lease) return 0;
        const ids = await this.repository.findDueIds(env.DLQ_RETRY_BATCH_SIZE);
        let claimed = 0;
        for (const id of ids) {
            if (this.stopRequested) break;
            const entry = await this.repository.claim(id, lease.ownerId, lease.epoch);
            if (!entry) continue;
            claimed++;
            if (!(await this.process(entry, lease))) break;
        }
        return claimed;
    }

    private async process(entry: UnprocessedMessage, lease: LeaseToken): Promise<boolean> {
        const log = {
            messageId: entry.messageId,
            source: entry.source,
            kind: entry.context.kind,
            attempt: entry.attempts + 1,
            correlationId: entry.correlationId,
        };
        let outcome: CompletionOutcome;
        const handler = this.registry.get(entry.source, entry.context.kind);
        if (!handler) {
            outcome = {
                kind: 'parked',
                error: new ProcessingError(
                    'handler_missing',
                    `tidak ada handler untuk ${entry.source}:${entry.context.kind}`
                ),
            };
        } else {
            try {
                const raw = await this.repository.readPayload(
                    entry,
                    Math.max(env.PVMBG_MAX_BODY_BYTES, env.DLQ_INLINE_MAX_BYTES)
                );
                const result = await handler(raw, entry, lease);
                outcome = { kind: 'recovered', hazardId: result.hazardId };
            } catch (error) {
                if (error instanceof LeaseLostError) {
                    this.leadership.invalidate(lease);
                    logger.info(log, 'Lost background lease during retry; claim will expire');
                    return false;
                }
                outcome = decideFailureOutcome(entry.attempts, classifyError(error), {
                    maxAttempts: entry.maxAttempts,
                    baseMs: env.DLQ_RETRY_BASE_MS,
                    capMs: env.DLQ_RETRY_CAP_MS,
                });
            }
        }

        try {
            const applied = await this.repository.complete(entry, lease, outcome);
            unprocessedRetryTotal.inc({ source: entry.source, outcome: applied ? outcome.kind : 'lost_claim' });
            logger.info(
                {
                    ...log,
                    outcome: outcome.kind,
                    applied,
                    reason: outcome.kind === 'recovered' ? undefined : outcome.error.reason,
                },
                'Processed unprocessed message retry'
            );
            return true;
        } catch (error) {
            if (error instanceof LeaseLostError) {
                this.leadership.invalidate(lease);
                return false;
            }
            logger.error(
                { ...log, error },
                'Could not record retry outcome; claim will expire and the entry is retried'
            );
            return true;
        }
    }
}
