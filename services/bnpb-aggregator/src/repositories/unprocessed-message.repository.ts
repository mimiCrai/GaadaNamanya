import { createHash } from 'node:crypto';
import { inject, injectable } from 'inversify';
import { Binary, ClientSession, ObjectId, UpdateFilter } from 'mongodb';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import { LeaseToken } from '../db/schema/background-leases';
import {
    UnprocessedContext,
    UnprocessedMessage,
    UnprocessedStatus,
    unprocessedMessages,
} from '../db/schema/unprocessed-messages';
import { computeBackoffMs } from '../libs/backoff';
import { ProcessingError } from '../libs/processing-error';
import { PayloadRef } from '../libs/safe-decode';
import env from '../util/env';
import { IBackgroundLeaseRepository } from './background-lease.repository';
import { IPayloadStore } from './payload-store.repository';

export type UnprocessedPayload =
    { kind: 'inline'; bytes: Buffer } | { kind: 'stored'; ref: PayloadRef; size: number; sha256: string };

export interface RecordUnprocessedInput {
    source: string;
    context: UnprocessedContext;
    payload: UnprocessedPayload;
    contentType: string;
    correlationId: string;
    sourceRefId?: string | null;
    error: ProcessingError;
}

export interface RecordUnprocessedResult {
    messageId: string;
    created: boolean;
    reopened: boolean;
    status: UnprocessedStatus;
}

export type CompletionOutcome =
    | { kind: 'recovered'; hazardId: string | null }
    | { kind: 'retry'; error: ProcessingError; delayMs: number }
    | { kind: 'parked'; error: ProcessingError };

export interface UnprocessedCount {
    source: string;
    status: UnprocessedStatus;
    count: number;
}

export interface IUnprocessedMessageRepository {
    record(input: RecordUnprocessedInput, lease?: LeaseToken): Promise<RecordUnprocessedResult>;
    findDueIds(limit: number): Promise<string[]>;
    claim(messageId: string, owner: string, epoch: number): Promise<UnprocessedMessage | null>;
    complete(entry: UnprocessedMessage, lease: LeaseToken, outcome: CompletionOutcome): Promise<boolean>;
    findById(messageId: string): Promise<UnprocessedMessage | null>;
    readPayload(entry: UnprocessedMessage, maxBytes: number): Promise<Buffer>;
    countByStatus(): Promise<UnprocessedCount[]>;
}

/** Stable id: the same broken bytes from the same source/context always map to one entry. */
export function computeMessageId(source: string, kind: string, payloadSha256: string): string {
    return `msg-${createHash('sha256').update(`${source}\n${kind}\n${payloadSha256}`).digest('hex').slice(0, 24)}`;
}

const HISTORY_LIMIT = 20;

@injectable()
export class UnprocessedMessageRepository implements IUnprocessedMessageRepository {
    constructor(
        @inject(TYPES.Database) private readonly db: CanonicalStore,
        @inject(TYPES.IBackgroundLeaseRepository) private readonly leases: IBackgroundLeaseRepository,
        @inject(TYPES.IPayloadStore) private readonly payloads: IPayloadStore
    ) {}

    private collection() {
        return this.db.collection<UnprocessedMessage>(unprocessedMessages);
    }

    async record(input: RecordUnprocessedInput, lease?: LeaseToken): Promise<RecordUnprocessedResult> {
        const stored = await this.placePayload(input);
        const messageId = computeMessageId(input.source, input.context.kind, stored.sha256);
        const { error } = input;
        const status: UnprocessedStatus = error.retryable ? 'retrying' : 'parked';

        const write = async (session: ClientSession | undefined, now: Date) => {
            const nextAttemptAt = error.retryable
                ? new Date(now.getTime() + computeBackoffMs(1, env.DLQ_RETRY_BASE_MS, env.DLQ_RETRY_CAP_MS))
                : null;
            const historyEntry = { at: now, attempt: 1, reason: error.reason, retryable: error.retryable };
            const failureFields = {
                reason: error.reason,
                category: error.category,
                retryable: error.retryable,
                attempts: 1,
                status,
                nextAttemptAt,
                claimedBy: null,
                claimEpoch: null,
                claimedUntil: null,
            };
            const upsert = await this.collection().updateOne(
                { _id: messageId },
                {
                    $setOnInsert: {
                        messageId,
                        source: input.source,
                        context: input.context,
                        receivedAt: now,
                        ...failureFields,
                        maxAttempts: env.DLQ_MAX_ATTEMPTS,
                        payload: stored.inline ? new Binary(stored.inline) : null,
                        payloadRef: stored.ref,
                        contentType: input.contentType,
                        sizeBytes: stored.size,
                        sha256: stored.sha256,
                        correlationId: input.correlationId,
                        sourceRefId: input.sourceRefId ?? null,
                        recoveredAt: null,
                        recoveredHazardId: null,
                        history: [historyEntry],
                    },
                    $max: { lastSeenAt: now },
                    $inc: { seenCount: 1 },
                },
                { upsert: true, session }
            );
            const created = upsert.upsertedCount === 1;
            let reopened = false;
            if (!created) {
                // The same bytes failed again after an earlier recovery: surface it again instead of hiding it.
                const reopen = await this.collection().updateOne(
                    { _id: messageId, status: 'recovered' },
                    {
                        $set: { ...failureFields, recoveredAt: null, recoveredHazardId: null },
                        $push: { history: { $each: [historyEntry], $slice: -HISTORY_LIMIT } },
                    },
                    { session }
                );
                reopened = reopen.modifiedCount === 1;
            }
            return { messageId, created, reopened, status };
        };

        const result = lease
            ? await this.leases.withLease(lease, (session, now) => write(session, now))
            : await write(undefined, new Date());

        if (!result.created && stored.ref) await this.dropDuplicatePayload(messageId, stored.ref);
        return result;
    }

    async findDueIds(limit: number): Promise<string[]> {
        const now = new Date();
        const docs = await this.collection()
            .find(
                {
                    status: 'retrying',
                    nextAttemptAt: { $lte: now },
                    $or: [{ claimedUntil: null }, { claimedUntil: { $lte: now } }],
                },
                { projection: { _id: 1 }, timeoutMS: env.STORAGE_READ_TIMEOUT_MS }
            )
            .sort({ nextAttemptAt: 1 })
            .limit(limit)
            .toArray();
        return docs.map((doc) => doc._id);
    }

    async claim(messageId: string, owner: string, epoch: number): Promise<UnprocessedMessage | null> {
        return this.collection().findOneAndUpdate(
            {
                _id: messageId,
                status: 'retrying',
                $expr: {
                    $and: [
                        { $lte: ['$nextAttemptAt', '$$NOW'] },
                        {
                            $or: [
                                { $eq: [{ $ifNull: ['$claimedUntil', null] }, null] },
                                { $lte: ['$claimedUntil', '$$NOW'] },
                            ],
                        },
                    ],
                },
            },
            [
                {
                    $set: {
                        claimedBy: { $literal: owner },
                        claimEpoch: { $literal: epoch },
                        claimedUntil: { $add: ['$$NOW', env.DLQ_CLAIM_MS] },
                    },
                },
            ],
            { returnDocument: 'after', timeoutMS: env.LEASE_OPERATION_TIMEOUT_MS }
        );
    }

    /** Applies the outcome only if this worker still owns the claim; fenced by the background lease. */
    async complete(entry: UnprocessedMessage, lease: LeaseToken, outcome: CompletionOutcome): Promise<boolean> {
        return this.leases.withLease(lease, async (session, now) => {
            const releaseClaim = { claimedBy: null, claimEpoch: null, claimedUntil: null };
            const attempt = entry.attempts + 1;
            let update: UpdateFilter<UnprocessedMessage>;
            if (outcome.kind === 'recovered') {
                update = {
                    $set: {
                        ...releaseClaim,
                        status: 'recovered',
                        nextAttemptAt: null,
                        recoveredAt: now,
                        recoveredHazardId: outcome.hazardId,
                    },
                    $inc: { attempts: 1 },
                };
            } else {
                const parked = outcome.kind === 'parked';
                update = {
                    $set: {
                        ...releaseClaim,
                        status: parked ? 'parked' : 'retrying',
                        retryable: !parked,
                        reason: outcome.error.reason,
                        category: outcome.error.category,
                        nextAttemptAt: parked ? null : new Date(now.getTime() + outcome.delayMs),
                    },
                    $inc: { attempts: 1 },
                    $push: {
                        history: {
                            $each: [{ at: now, attempt, reason: outcome.error.reason, retryable: !parked }],
                            $slice: -HISTORY_LIMIT,
                        },
                    },
                };
            }
            const result = await this.collection().updateOne(
                { _id: entry.messageId, status: 'retrying', claimedBy: entry.claimedBy, claimEpoch: entry.claimEpoch },
                update,
                { session }
            );
            return result.modifiedCount === 1;
        });
    }

    async findById(messageId: string): Promise<UnprocessedMessage | null> {
        return this.collection().findOne({ _id: messageId }, { timeoutMS: env.STORAGE_READ_TIMEOUT_MS });
    }

    async readPayload(entry: UnprocessedMessage, maxBytes: number): Promise<Buffer> {
        if (entry.payload) return Buffer.from(entry.payload.buffer);
        if (entry.payloadRef) return this.payloads.readAll(entry.payloadRef, maxBytes);
        throw new Error(`Unprocessed message ${entry.messageId} has no payload`);
    }

    async countByStatus(): Promise<UnprocessedCount[]> {
        const rows = await this.collection()
            .aggregate<{ _id: { source: string; status: UnprocessedStatus }; count: number }>(
                [{ $group: { _id: { source: '$source', status: '$status' }, count: { $sum: 1 } } }],
                { maxTimeMS: env.STORAGE_READ_TIMEOUT_MS }
            )
            .toArray();
        return rows.map((row) => ({ source: row._id.source, status: row._id.status, count: row.count }));
    }

    /** Large inline payloads (e.g. one huge record) are moved to GridFS so documents stay under 16 MiB. */
    private async placePayload(
        input: RecordUnprocessedInput
    ): Promise<{ inline: Buffer | null; ref: ObjectId | null; size: number; sha256: string }> {
        if (input.payload.kind === 'stored') {
            return {
                inline: null,
                ref: new ObjectId(input.payload.ref.id),
                size: input.payload.size,
                sha256: input.payload.sha256,
            };
        }
        const bytes = input.payload.bytes;
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (bytes.length <= env.DLQ_INLINE_MAX_BYTES) return { inline: bytes, ref: null, size: bytes.length, sha256 };
        const sink = this.payloads.openSink({ source: input.source, kind: input.context.kind, sha256 });
        for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
            await sink.write(bytes.subarray(offset, offset + 256 * 1024));
        }
        const ref = await sink.finish();
        return { inline: null, ref: new ObjectId(ref.id), size: bytes.length, sha256 };
    }

    private async dropDuplicatePayload(messageId: string, ref: ObjectId): Promise<void> {
        const existing = await this.collection().findOne({ _id: messageId }, { projection: { payloadRef: 1 } });
        if (!existing?.payloadRef || !existing.payloadRef.equals(ref)) await this.payloads.delete(ref);
    }
}
