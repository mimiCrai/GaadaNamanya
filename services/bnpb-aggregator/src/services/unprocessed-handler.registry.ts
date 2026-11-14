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
) => Promise<{ hazardId: string | null }>;

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
        this.register(HazardSource.Pvmbg, PVMBG_RECORD_KIND, async (raw, entry, lease) => ({
            hazardId: await ingestion.reprocessVolcanicRecord(raw, entry.correlationId, lease),
        }));
        this.register(HazardSource.Pvmbg, PVMBG_RESPONSE_KIND, async (raw, entry, lease) => {
            await ingestion.reprocessVolcanicResponse(raw, entry.correlationId, lease);
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
