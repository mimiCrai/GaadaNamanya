import { AnyBulkWriteOperation, MongoServerError } from 'mongodb';
import { v5 as uuidv5 } from 'uuid';
import { CanonicalStore } from '../db';
import { inject, injectable } from 'inversify';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TYPES } from '../constants/types';
import { HazardEvent, HazardSource, HazardType, HazardSeverity, hazardEvents } from '../db/schema/hazard-events';
import { HazardEventChangeType, OutboxEvent, outboxEvents } from '../db/schema/outbox-events';
import { LeaseToken } from '../db/schema/background-leases';
import { IBackgroundLeaseRepository } from './background-lease.repository';
import { captureTrace } from '../telemetry/context';

export interface UpsertHazardEventInput {
    source: HazardSource;
    sourceRefId: string;
    hazardType: HazardType;
    severity: HazardSeverity;
    areaName: string;
    latitude: number;
    longitude: number;
    occurredAt: Date;
    attributes: Record<string, unknown>;
    topic: string;
    correlationId: string;
    lease: LeaseToken;
    /**
     * Optional ordering version per (source, source_ref_id), compared as a string (fixed-width, sortable).
     * When set, the write applies only if it is >= the stored version; an older write is `superseded`
     * (review #3). Writes without a version are not guarded (BMKG, tsunami warnings).
     */
    version?: string;
}

export interface HazardEventUpsertResult {
    hazardEvent: HazardEvent;
    changeType: HazardEventChangeType | null;
    /** The stored event carries a newer version: nothing was written and nothing enqueued. */
    superseded?: boolean;
}

/**
 * PERLU DIKONFIRMASI KE A/B: `version` is an internal field of hazard_events (ordering guard, review #3).
 * It is excluded from every read of this repository and never enters outbox payloads or audit items.
 */
type StoredHazardEvent = HazardEvent & { version?: string };
const HIDE_INTERNAL = { _id: 0, version: 0 } as const;

/** True when the incoming write is older than what is stored (both versioned). */
export function isSupersededVersion(stored: string | undefined, incoming: string | undefined): boolean {
    return stored !== undefined && incoming !== undefined && incoming < stored;
}

export interface IHazardEventRepository {
    findAll(ingestedSince?: Date, source?: HazardSource): Promise<HazardEvent[]>;
    findByHazardId(hazardId: string): Promise<HazardEvent | undefined>;
    findBySourceAndRefId(source: HazardSource, sourceRefId: string): Promise<HazardEvent | undefined>;
    upsertAndEnqueue(input: UpsertHazardEventInput): Promise<HazardEventUpsertResult>;
    upsertBatchAndEnqueue(inputs: UpsertHazardEventInput[]): Promise<HazardEventUpsertResult[]>;
}

@injectable()
export class HazardEventRepository implements IHazardEventRepository {
    constructor(
        @inject(TYPES.Database) private readonly db: CanonicalStore,
        @inject(TYPES.IBackgroundLeaseRepository) private readonly leases: IBackgroundLeaseRepository
    ) {}

    async findAll(ingestedSince?: Date, source?: HazardSource): Promise<HazardEvent[]> {
        const filter = {
            ...(source ? { source } : {}),
            ...(ingestedSince ? { ingestedAt: { $gte: ingestedSince } } : {}),
        };
        return this.db
            .collection<HazardEvent>(hazardEvents)
            .find<HazardEvent>(filter, { projection: HIDE_INTERNAL })
            .sort(ingestedSince ? { ingestedAt: 1, hazardId: 1 } : { occurredAt: -1, hazardId: 1 })
            .toArray();
    }

    async findByHazardId(hazardId: string): Promise<HazardEvent | undefined> {
        return (
            (await this.db
                .collection<HazardEvent>(hazardEvents)
                .findOne<HazardEvent>({ _id: hazardId }, { projection: HIDE_INTERNAL })) ?? undefined
        );
    }

    async findBySourceAndRefId(source: HazardSource, sourceRefId: string): Promise<HazardEvent | undefined> {
        return this.findByHazardId(this.canonicalId(source, sourceRefId));
    }

    async upsertAndEnqueue(input: UpsertHazardEventInput): Promise<HazardEventUpsertResult> {
        const hazardId = this.canonicalId(input.source, input.sourceRefId);
        const outboxEventId = randomUUID();
        const traceContext = captureTrace();
        // Concurrent first inserts can raise E11000 instead of a retryable transaction error.
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.leases.withLease(input.lease, async (session, now) => {
                    const collection = this.db.collection<StoredHazardEvent>(hazardEvents);
                    const stored = await collection.findOne<StoredHazardEvent>(
                        { _id: hazardId },
                        { session, projection: { _id: 0 } }
                    );
                    const { version: storedVersion, ...existingEvent } = stored ?? {};
                    const existing = stored ? (existingEvent as HazardEvent) : null;

                    if (existing && isSupersededVersion(storedVersion, input.version)) {
                        return { hazardEvent: existing, changeType: null, superseded: true };
                    }
                    if (existing && this.hasSameContent(existing, input)) {
                        // Same content received again later: move the version so an older replay stays older.
                        if (input.version !== undefined && input.version !== storedVersion) {
                            await collection.updateOne(
                                { _id: hazardId },
                                { $set: { version: input.version } },
                                { session }
                            );
                        }
                        return { hazardEvent: existing, changeType: null };
                    }

                    const hazardEvent: HazardEvent = {
                        hazardId,
                        source: input.source,
                        sourceRefId: input.sourceRefId,
                        hazardType: input.hazardType,
                        severity: input.severity,
                        areaName: input.areaName,
                        latitude: input.latitude,
                        longitude: input.longitude,
                        occurredAt: input.occurredAt,
                        ingestedAt: now,
                        attributes: input.attributes,
                    };
                    const changeType = existing ? HazardEventChangeType.Updated : HazardEventChangeType.Created;
                    const document: StoredHazardEvent =
                        input.version === undefined ? hazardEvent : { ...hazardEvent, version: input.version };
                    if (existing) {
                        // The guard is also in the filter (shard key _id + version), so the store itself refuses an
                        // older write even if the read above were stale; matched 0 → superseded, nothing enqueued.
                        const guard =
                            input.version === undefined
                                ? {}
                                : { $or: [{ version: { $exists: false } }, { version: { $lte: input.version } }] };
                        const replaced = await collection.replaceOne({ _id: hazardId, ...guard }, document, {
                            session,
                        });
                        if (replaced.matchedCount !== 1) {
                            return { hazardEvent: existing, changeType: null, superseded: true };
                        }
                    } else {
                        await collection.insertOne({ _id: hazardId, ...document }, { session });
                    }

                    await this.db.collection<OutboxEvent>(outboxEvents).insertOne(
                        {
                            _id: outboxEventId,
                            outboxEventId,
                            aggregateId: hazardId,
                            eventType: changeType,
                            topic: input.topic,
                            partitionKey: hazardId,
                            payload: {
                                eventId: outboxEventId,
                                eventType: changeType,
                                correlationId: input.correlationId,
                                hazard: this.toEventPayload(hazardEvent),
                            },
                            createdAt: now,
                            ...(Object.keys(traceContext).length ? { traceContext } : {}),
                            publishedAt: null,
                            publishAttempts: 0,
                            lastError: null,
                        },
                        { session }
                    );
                    return { hazardEvent, changeType };
                });
            } catch (error) {
                if (!(error instanceof MongoServerError) || error.code !== 11000 || attempt >= 2) {
                    throw error;
                }
            }
        }
    }

    async upsertBatchAndEnqueue(inputs: UpsertHazardEventInput[]): Promise<HazardEventUpsertResult[]> {
        if (!inputs.length) return [];
        const traceContext = captureTrace();
        const lease = inputs[0].lease;
        const ids = inputs.map((input) => this.canonicalId(input.source, input.sourceRefId));
        if (
            inputs.length > 50 ||
            new Set(ids).size !== ids.length ||
            inputs.some((input) => input.lease.ownerId !== lease.ownerId || input.lease.epoch !== lease.epoch)
        ) {
            throw new Error('Hazard batches require at most 50 distinct identities and one lease');
        }
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.leases.withLease(lease, async (session, now) => {
                    const existing = await this.db
                        .collection<HazardEvent>(hazardEvents)
                        .find<HazardEvent>({ _id: { $in: ids } }, { session, projection: { _id: 0 } })
                        .toArray();
                    const byId = new Map(existing.map((event) => [event.hazardId, event]));
                    const writes: AnyBulkWriteOperation<HazardEvent & { _id: string }>[] = [];
                    const events: (OutboxEvent & { _id: string })[] = [];
                    const results = inputs.map((input, index): HazardEventUpsertResult => {
                        const previous = byId.get(ids[index]);
                        if (previous && this.hasSameContent(previous, input))
                            return { hazardEvent: previous, changeType: null };
                        const hazardEvent: HazardEvent = {
                            hazardId: ids[index],
                            source: input.source,
                            sourceRefId: input.sourceRefId,
                            hazardType: input.hazardType,
                            severity: input.severity,
                            areaName: input.areaName,
                            latitude: input.latitude,
                            longitude: input.longitude,
                            occurredAt: input.occurredAt,
                            ingestedAt: now,
                            attributes: input.attributes,
                        };
                        const changeType = previous ? HazardEventChangeType.Updated : HazardEventChangeType.Created;
                        writes.push({
                            replaceOne: {
                                filter: { _id: ids[index] },
                                replacement: hazardEvent,
                                upsert: true,
                            },
                        });
                        const outboxEventId = randomUUID();
                        events.push({
                            _id: outboxEventId,
                            outboxEventId,
                            aggregateId: ids[index],
                            eventType: changeType,
                            topic: input.topic,
                            partitionKey: ids[index],
                            createdAt: now,
                            ...(Object.keys(traceContext).length ? { traceContext } : {}),
                            publishedAt: null,
                            publishAttempts: 0,
                            lastError: null,
                            payload: {
                                eventId: outboxEventId,
                                eventType: changeType,
                                correlationId: input.correlationId,
                                hazard: this.toEventPayload(hazardEvent),
                            },
                        });
                        return { hazardEvent, changeType };
                    });
                    if (writes.length) {
                        await this.db
                            .collection<HazardEvent>(hazardEvents)
                            .bulkWrite(writes, { session, ordered: true });
                        await this.db
                            .collection<OutboxEvent>(outboxEvents)
                            .insertMany(events, { session, ordered: true });
                    }
                    return results;
                });
            } catch (error) {
                if (!(error instanceof MongoServerError) || error.code !== 11000 || attempt >= 2) throw error;
            }
        }
    }

    private canonicalId(source: HazardSource, sourceRefId: string): string {
        return uuidv5(JSON.stringify([source, sourceRefId]), uuidv5.URL);
    }

    private hasSameContent(existing: HazardEvent, input: UpsertHazardEventInput): boolean {
        return (
            existing.hazardType === input.hazardType &&
            existing.severity === input.severity &&
            existing.areaName === input.areaName &&
            existing.latitude === input.latitude &&
            existing.longitude === input.longitude &&
            existing.occurredAt.getTime() === input.occurredAt.getTime() &&
            isDeepStrictEqual(existing.attributes, input.attributes)
        );
    }

    private toEventPayload(hazardEvent: HazardEvent): Record<string, unknown> {
        return {
            ...hazardEvent,
            occurredAt: hazardEvent.occurredAt.toISOString(),
            ingestedAt: hazardEvent.ingestedAt.toISOString(),
        };
    }
}
