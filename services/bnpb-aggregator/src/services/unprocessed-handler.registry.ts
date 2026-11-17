import { inject, injectable } from 'inversify';
import { PVMBG_RECORD_KIND, PVMBG_RESPONSE_KIND } from '../clients/pvmbg.client';
import { TYPES } from '../constants/types';
import { LeaseToken } from '../db/schema/background-leases';
import { HazardSource } from '../db/schema/hazard-events';
import { UnprocessedMessage } from '../db/schema/unprocessed-messages';
import { IHazardEventIngestionService } from './hazard-event-ingestion.service';

export type UnprocessedHandler = (
    raw: Buffer,
    entry: UnprocessedMessage,
    lease: LeaseToken
) => Promise<{ hazardId: string | null; superseded?: boolean }>;

export interface IUnprocessedHandlerRegistry {
    register(source: string, kind: string, handler: UnprocessedHandler): void;
    get(source: string, kind: string): UnprocessedHandler | undefined;
    keys(): string[];
}

export function handlerKey(source: string, kind: string): string {
    return `${source}:${kind}`;
}

@injectable()
export class UnprocessedHandlerRegistry implements IUnprocessedHandlerRegistry {
    private readonly handlers = new Map<string, UnprocessedHandler>();

    constructor(@inject(TYPES.IHazardEventIngestionService) ingestion: IHazardEventIngestionService) {
        // entry.ordering = receive order stored at quarantine: a replay keeps its original place (review #3).
        this.register(HazardSource.Pvmbg, PVMBG_RECORD_KIND, (raw, entry, lease) =>
            ingestion.reprocessVolcanicRecord(raw, entry.correlationId, lease, entry.ordering)
        );
        this.register(HazardSource.Pvmbg, PVMBG_RESPONSE_KIND, async (raw, entry, lease) => {
            await ingestion.reprocessVolcanicResponse(raw, entry.correlationId, lease, entry.ordering);
            return { hazardId: null };
        });
    }

    register(source: string, kind: string, handler: UnprocessedHandler): void {
        this.handlers.set(handlerKey(source, kind), handler);
    }

    get(source: string, kind: string): UnprocessedHandler | undefined {
        return this.handlers.get(handlerKey(source, kind));
    }

    keys(): string[] {
        return [...this.handlers.keys()].sort();
    }
}
