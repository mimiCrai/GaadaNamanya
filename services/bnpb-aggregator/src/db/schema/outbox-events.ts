export enum HazardEventChangeType {
    Created = 'hazard.created',
    Updated = 'hazard.updated',
    // P4: a merged or vanished fire is removed from hazard_events (checksum stays exact)
    Deleted = 'hazard.deleted',
}

export const outboxEvents = 'outbox_events';

export interface OutboxEvent {
    outboxEventId: string;
    aggregateId: string;
    eventType: HazardEventChangeType;
    topic: string;
    partitionKey: string;
    payload: Record<string, unknown>;
    traceContext?: Record<string, string>;
    createdAt: Date;
    publishedAt: Date | null;
    publishAttempts: number;
    lastError: string | null;
}
