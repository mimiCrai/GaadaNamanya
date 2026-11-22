import { inject, injectable } from 'inversify';
import { z } from 'zod';
import { IPvmbgClient, PVMBG_ENDPOINT, VolcanicReportBatch } from '../clients/pvmbg.client';
import { TYPES } from '../constants/types';
import { LeaseToken } from '../db/schema/background-leases';
import { HazardSource } from '../db/schema/hazard-events';
import { SourceStream } from '../db/schema/source-sync-states';
import { UnprocessedMessage } from '../db/schema/unprocessed-messages';
import { logger } from '../libs/logger';
import { pvmbgBodyFailuresTotal, pvmbgSkippedWindowsTotal } from '../libs/metrics';
import { ProcessingError } from '../libs/processing-error';
import { decodeJson } from '../libs/safe-decode';
import env from '../util/env';
import { IHazardEventIngestionService } from './hazard-event-ingestion.service';
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

// D-44: the poll moves the cursor past the window but must not count as a success
export interface SkippedWindow {
    messageId: string;
    error: ProcessingError;
}

export interface IPvmbgBodyFailureService {
    // throws SourceBodyHeldError while below K; at K records the skipped window for backfill and returns it
    onBodyFailure(bodyFailure: ProcessingError, window: PollWindow, lease: LeaseToken): Promise<SkippedWindow>;
}

@injectable()
export class PvmbgBodyFailureService implements IPvmbgBodyFailureService {
    constructor(
        @inject(TYPES.ISourceSyncStateService) private readonly states: ISourceSyncStateService,
        @inject(TYPES.IUnprocessedRecorder) private readonly unprocessed: IUnprocessedRecorder
    ) {}

    async onBodyFailure(bodyFailure: ProcessingError, window: PollWindow, lease: LeaseToken): Promise<SkippedWindow> {
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
        // retryable (D-44): the retry worker backfills the window with GET since=<since> once the source serves a valid body
        const error = new ProcessingError(
            'window_skipped',
            `jendela poll [${since ?? 'awal'}, ${until}) dilewati setelah ${failuresSoFar + 1} body rusak berturut-turut; diisi ulang retry worker dengan since=${since ?? 'awal'}`
        );
        const recorded = await this.unprocessed.record(
            {
                source: HazardSource.Pvmbg,
                context: { kind: PVMBG_WINDOW_SKIPPED_KIND, endpoint: PVMBG_ENDPOINT, topic: null },
                payload: { kind: 'inline', bytes: Buffer.from(JSON.stringify(description)) },
                contentType: 'application/json',
                correlationId: window.correlationId,
                error,
            },
            lease
        );
        pvmbgBodyFailuresTotal.inc({ outcome: 'advanced' });
        pvmbgSkippedWindowsTotal.inc();
        logger.warn(
            { ...description, messageId: recorded.messageId, correlationId: window.correlationId },
            'PVMBG checkpoint forced forward after consecutive body failures; skipped window queued for backfill'
        );
        return { messageId: recorded.messageId, error };
    }
}

const skippedWindowSchema = z.object({
    since: z.string().datetime().nullable(),
    until: z.string().datetime(),
});

// largest page GET /volcanic-reports accepts (limit 1..1000)
export const PVMBG_BACKFILL_PAGE_LIMIT = 1000;

interface PageCursor {
    reportedAt: Date;
    reportId: string;
}

// pages come ordered by (reported_at, report_id); the last record carrying both is the next keyset cursor
function lastCursor(records: VolcanicReportBatch['records']): PageCursor | null {
    for (let index = records.length - 1; index >= 0; index--) {
        const value = records[index].value as { reported_at?: unknown; report_id?: unknown } | null;
        const ms = typeof value?.reported_at === 'string' ? Date.parse(value.reported_at) : NaN;
        if (Number.isFinite(ms) && typeof value?.report_id === 'string' && value.report_id.length > 0) {
            return { reportedAt: new Date(ms), reportId: value.report_id };
        }
    }
    return null;
}

// the source returns rows strictly after the cursor, so a repeat means it ignored after_id
const sameCursor = (a: PageCursor | null, b: PageCursor | null) =>
    !!a && !!b && a.reportedAt.getTime() === b.reportedAt.getTime() && a.reportId === b.reportId;

/** D-44 backfill: page through the whole skipped window via the normal ingest path; the version guard makes overlap a no-op. */
export async function backfillSkippedWindow(
    raw: Buffer,
    entry: Pick<UnprocessedMessage, 'messageId' | 'correlationId'>,
    lease: LeaseToken,
    pvmbg: IPvmbgClient,
    ingestion: Pick<IHazardEventIngestionService, 'ingestVolcanicBatch'>,
    pageLimit = PVMBG_BACKFILL_PAGE_LIMIT
): Promise<{ hazardId: null }> {
    const parsed = skippedWindowSchema.safeParse(decodeJson(raw, { maxDepth: env.DECODE_MAX_DEPTH }));
    if (!parsed.success) throw new ProcessingError('validation_failed', 'entri window_skipped tidak memuat since/until yang valid');
    const until = new Date(parsed.data.until);
    const since = parsed.data.since ? new Date(parsed.data.since) : undefined;
    let cursor: PageCursor | null = null;
    let pages = 0;
    let records = 0;
    // the entry closes only once a short page or a page reaching `until` proves the window is drained
    for (;;) {
        const batch = await pvmbg.getVolcanicReports({
            since: cursor?.reportedAt ?? since,
            afterId: cursor?.reportId,
            limit: pageLimit,
            correlationId: entry.correlationId,
            instanceId: lease.ownerId,
            fencingToken: lease.epoch,
        });
        const result = await ingestion.ingestVolcanicBatch(batch, entry.correlationId, lease);
        if (result.bodyFailure) {
            throw new ProcessingError('window_skipped', `body PVMBG masih rusak saat isi ulang jendela (${result.bodyFailure.reason})`);
        }
        pages++;
        records += batch.records.length;
        if (batch.records.length < pageLimit) break;
        const last = lastCursor(batch.records);
        if (last && last.reportedAt.getTime() >= until.getTime()) break;
        // keyset paging (ties on reported_at included); a cursor that does not move would repeat forever
        if (!last || sameCursor(last, cursor) || (cursor && last.reportedAt < cursor.reportedAt)) {
            throw new ProcessingError(
                'window_skipped',
                `isi ulang jendela macet: kursor ${last ? `${last.reportedAt.toISOString()}/${last.reportId}` : 'tidak terbaca'} tidak maju (sumber mengabaikan after_id?)`
            );
        }
        cursor = last;
    }
    logger.info(
        {
            messageId: entry.messageId,
            since: parsed.data.since,
            until: parsed.data.until,
            pages,
            records,
            correlationId: entry.correlationId,
        },
        'PVMBG skipped window backfilled'
    );
    return { hazardId: null };
}
