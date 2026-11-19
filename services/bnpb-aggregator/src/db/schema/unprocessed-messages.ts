import { Binary, ObjectId } from 'mongodb';
import { ErrorCategory } from '../../libs/processing-error';
import type { ReceiveOrder } from '../../libs/receive-order';

export const unprocessedMessages = 'unprocessed_messages';
export const unprocessedPayloadBucket = 'unprocessed_payloads';

/** recovered = replay applied; superseded = replay closed because a newer version was already stored */
export type UnprocessedStatus = 'retrying' | 'parked' | 'recovered' | 'superseded';

export interface UnprocessedContext {
    kind: string;
    endpoint: string | null;
    topic: string | null;
}

export interface UnprocessedHistoryEntry {
    at: Date;
    attempt: number;
    reason: string;
    retryable: boolean;
}

export interface UnprocessedMessage {
    messageId: string;
    source: string;
    context: UnprocessedContext;
    receivedAt: Date;
    lastSeenAt: Date;
    seenCount: number;
    reason: string;
    category: ErrorCategory;
    retryable: boolean;
    attempts: number;
    maxAttempts: number;
    status: UnprocessedStatus;
    nextAttemptAt: Date | null;
    claimedBy: string | null;
    claimEpoch: number | null;
    claimedUntil: Date | null;
    payload: Binary | null;
    payloadRef: ObjectId | null;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    correlationId: string;
    sourceRefId: string | null;
    /** Receive order of the quarantined record, reused on replay (absent on entries written before it existed). */
    ordering?: ReceiveOrder | null;
    recoveredAt: Date | null;
    recoveredHazardId: string | null;
    history: UnprocessedHistoryEntry[];
}
