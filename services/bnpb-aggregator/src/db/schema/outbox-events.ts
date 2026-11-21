export enum HazardEventChangeType {
    Created = 'hazard.created',
    Updated = 'hazard.updated',
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
