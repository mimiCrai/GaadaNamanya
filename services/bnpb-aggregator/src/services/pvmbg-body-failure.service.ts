import { inject, injectable } from 'inversify';
import { PVMBG_ENDPOINT } from '../clients/pvmbg.client';
import { TYPES } from '../constants/types';
import { LeaseToken } from '../db/schema/background-leases';
import { HazardSource } from '../db/schema/hazard-events';
import { SourceStream } from '../db/schema/source-sync-states';
import { logger } from '../libs/logger';
import { pvmbgBodyFailuresTotal, pvmbgSkippedWindowsTotal } from '../libs/metrics';
import { ProcessingError } from '../libs/processing-error';
import env from '../util/env';
import { ISourceSyncStateService } from './source-sync-state.service';
import { IUnprocessedRecorder } from './unprocessed-recorder.service';

export const PVMBG_WINDOW_SKIPPED_KIND = 'poll.window-skipped';

export interface PollWindow {
    since?: Date;
    until: Date;
    correlationId: string;
}

// Thrown so the poll counts as failed and the checkpoint stays (D-34).
export class SourceBodyHeldError extends Error {
    constructor(
        readonly bodyFailure: ProcessingError,
        readonly heldPolls: number
    ) {
        super(`body PVMBG rusak, checkpoint ditahan (${heldPolls}/${env.PVMBG_BODY_FAILURE_HOLD_POLLS}): ${bodyFailure.reason}`);
        this.name = 'SourceBodyHeldError';
    }
}

export interface IPvmbgBodyFailureService {
    // throws SourceBodyHeldError while below K; at K records the skipped window and returns (checkpoint advances)
    onBodyFailure(bodyFailure: ProcessingError, window: PollWindow, lease: LeaseToken): Promise<void>;
}

@injectable()
export class PvmbgBodyFailureService implements IPvmbgBodyFailureService {
    constructor(
        @inject(TYPES.ISourceSyncStateService) private readonly states: ISourceSyncStateService,
        @inject(TYPES.IUnprocessedRecorder) private readonly unprocessed: IUnprocessedRecorder
    ) {}

    async onBodyFailure(bodyFailure: ProcessingError, window: PollWindow, lease: LeaseToken): Promise<void> {
        const state = await this.states.getState(SourceStream.PvmbgVolcanic);
        const failuresSoFar = state?.consecutiveBodyFailures ?? 0;
        const limit = env.PVMBG_BODY_FAILURE_HOLD_POLLS;

        if (failuresSoFar + 1 < limit) {
            const held = await this.states.recordHeldBodyFailure(SourceStream.PvmbgVolcanic, lease);
            pvmbgBodyFailuresTotal.inc({ outcome: 'held' });
            throw new SourceBodyHeldError(bodyFailure, held);
        }

        const since = window.since?.toISOString() ?? null;
        const until = window.until.toISOString();
        const description = {
            source: HazardSource.Pvmbg,
            endpoint: PVMBG_ENDPOINT,
            since,
            until,
            consecutive_body_failures: failuresSoFar + 1,
            last_failure: bodyFailure.reason,
        };
        await this.unprocessed.record(
            {
                source: HazardSource.Pvmbg,
                context: { kind: PVMBG_WINDOW_SKIPPED_KIND, endpoint: PVMBG_ENDPOINT, topic: null },
                payload: { kind: 'inline', bytes: Buffer.from(JSON.stringify(description)) },
                contentType: 'application/json',
                correlationId: window.correlationId,
                error: new ProcessingError(
                    'window_skipped',
                    `jendela poll [${since ?? 'awal'}, ${until}) dilewati setelah ${failuresSoFar + 1} body rusak berturut-turut; isi ulang manual dengan since=${since ?? 'awal'}`
                ),
            },
            lease
        );
        pvmbgBodyFailuresTotal.inc({ outcome: 'advanced' });
        pvmbgSkippedWindowsTotal.inc();
        logger.warn(
            { ...description, correlationId: window.correlationId },
            'PVMBG checkpoint forced forward after consecutive body failures; skipped window recorded in the DLQ'
        );
    }
}
