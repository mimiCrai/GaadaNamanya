import { inject, injectable, optional } from 'inversify';
import { IPvmbgClient, PVMBG_RECORD_KIND, PVMBG_RESPONSE_KIND } from '../clients/pvmbg.client';
import { TYPES } from '../constants/types';
import { LeaseToken } from '../db/schema/background-leases';
import { HazardSource } from '../db/schema/hazard-events';
import { UnprocessedMessage } from '../db/schema/unprocessed-messages';
import { IHazardEventIngestionService } from './hazard-event-ingestion.service';
import { FIELD_REPORT_SOURCE } from '../db/schema/unprocessed-messages';
import { fieldReportConflictError, fieldReportMessageSchema } from '../libs/field-report';
import { ProcessingError } from '../libs/processing-error';
import { decodeJson } from '../libs/safe-decode';
import { IFieldReportRepository } from '../repositories/field-report.repository';
import type { ReplayableKind } from '../repositories/unprocessed-message.repository';
import env from '../util/env';
import { backfillSkippedWindow, PVMBG_WINDOW_SKIPPED_KIND } from './pvmbg-body-failure.service';

export const FIELD_REPORT_KIND = 'kafka.field-report';

export type UnprocessedHandler = (
    raw: Buffer,
    entry: UnprocessedMessage,
    lease: LeaseToken
) => Promise<{ hazardId: string | null; superseded?: boolean }>;

export interface IUnprocessedHandlerRegistry {
    register(source: string, kind: string, handler: UnprocessedHandler): void;
    get(source: string, kind: string): UnprocessedHandler | undefined;
    keys(): string[];
    // (source, kind) pairs with a handler: replay selects only these before applying its limit (D-45)
    replayable(): ReplayableKind[];
}

export function handlerKey(source: string, kind: string): string {
    return `${source}:${kind}`;
}

@injectable()
export class UnprocessedHandlerRegistry implements IUnprocessedHandlerRegistry {
    private readonly handlers = new Map<string, UnprocessedHandler>();
    private readonly kinds = new Map<string, ReplayableKind>();

    constructor(
        @inject(TYPES.IHazardEventIngestionService) ingestion: IHazardEventIngestionService,
        @inject(TYPES.IFieldReportRepository) @optional() fieldReports?: IFieldReportRepository,
        @inject(TYPES.IPvmbgClient) @optional() pvmbg?: IPvmbgClient
    ) {
        // entry.ordering = receive order stored at quarantine: a replay keeps its original place (review #3).
        this.register(HazardSource.Pvmbg, PVMBG_RECORD_KIND, (raw, entry, lease) =>
            ingestion.reprocessVolcanicRecord(raw, entry.correlationId, lease, entry.ordering)
        );
        this.register(HazardSource.Pvmbg, PVMBG_RESPONSE_KIND, async (raw, entry, lease) => {
            await ingestion.reprocessVolcanicResponse(raw, entry.correlationId, lease, entry.ordering);
            return { hazardId: null };
        });
        // D-44 backfill: a window skipped after K broken bodies is re-polled with its since
        if (pvmbg) {
            this.register(HazardSource.Pvmbg, PVMBG_WINDOW_SKIPPED_KIND, (raw, entry, lease) =>
                backfillSkippedWindow(raw, entry, lease, pvmbg, ingestion)
            );
        }
        // replay of a field report the consumer could not store (D-39): the same idempotent insert
        if (fieldReports) {
            this.register(FIELD_REPORT_SOURCE, FIELD_REPORT_KIND, async (raw, entry) => {
                const parsed = fieldReportMessageSchema.safeParse(decodeJson(raw, { maxDepth: env.DECODE_MAX_DEPTH }));
                if (!parsed.success) throw new ProcessingError('validation_failed', 'pesan field report tidak sesuai kontrak');
                const write = await fieldReports.insertOnce(parsed.data, null, entry.correlationId);
                if (write.result === 'conflict') {
                    throw fieldReportConflictError(parsed.data.report.report_id, write.report.contentSha256, write.incomingSha256);
                }
                return { hazardId: null };
            });
        }
    }

    register(source: string, kind: string, handler: UnprocessedHandler): void {
        this.handlers.set(handlerKey(source, kind), handler);
        this.kinds.set(handlerKey(source, kind), { source, kind });
    }

    get(source: string, kind: string): UnprocessedHandler | undefined {
        return this.handlers.get(handlerKey(source, kind));
    }

    keys(): string[] {
        return [...this.handlers.keys()].sort();
    }

    replayable(): ReplayableKind[] {
        return [...this.kinds.values()];
    }
}
