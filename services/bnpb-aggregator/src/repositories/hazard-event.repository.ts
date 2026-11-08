import { MongoServerError } from 'mongodb';
import { v5 as uuidv5 } from 'uuid';
import { CanonicalStore } from '../db';
import { inject, injectable } from 'inversify';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TYPES } from '../constants/types';
import { HazardEvent, HazardSource, HazardType, HazardSeverity, hazardEvents } from '../db/schema/hazard-events';
import { HazardEventChangeType, OutboxEvent, outboxEvents } from '../db/schema/outbox-events';

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
}

export interface HazardEventUpsertResult {
    hazardEvent: HazardEvent;
    changeType: HazardEventChangeType | null;
}

export interface IHazardEventRepository {
    findAll(ingestedSince?: Date, source?: HazardSource): Promise<HazardEvent[]>;
    findByHazardId(hazardId: string): Promise<HazardEvent | undefined>;
    findBySourceAndRefId(source: HazardSource, sourceRefId: string): Promise<HazardEvent | undefined>;
    upsertAndEnqueue(input: UpsertHazardEventInput): Promise<HazardEventUpsertResult>;
}

@injectable()
export class HazardEventRepository implements IHazardEventRepository {
    constructor(@inject(TYPES.Database) private readonly db: CanonicalStore) {}

    async findAll(ingestedSince?: Date, source?: HazardSource): Promise<HazardEvent[]> {
        const filter = {
            ...(source ? { source } : {}),
            ...(ingestedSince ? { ingestedAt: { $gte: ingestedSince } } : {}),
        };
        return this.db
            .collection<HazardEvent>(hazardEvents)
            .find<HazardEvent>(filter, { projection: { _id: 0 } })
            .sort(ingestedSince ? { ingestedAt: 1, hazardId: 1 } : { occurredAt: -1, hazardId: 1 })
            .toArray();
    }

    async findByHazardId(hazardId: string): Promise<HazardEvent | undefined> {
        return (
            (await this.db
                .collection<HazardEvent>(hazardEvents)
                .findOne<HazardEvent>({ _id: hazardId }, { projection: { _id: 0 } })) ?? undefined
        );
    }

    async findBySourceAndRefId(source: HazardSource, sourceRefId: string): Promise<HazardEvent | undefined> {
        return this.findByHazardId(this.canonicalId(source, sourceRefId));
    }

    async upsertAndEnqueue(input: UpsertHazardEventInput): Promise<HazardEventUpsertResult> {
        const hazardId = this.canonicalId(input.source, input.sourceRefId);
        const outboxEventId = randomUUID();
        const session = this.db.client.startSession();
        try {
            // Concurrent first inserts can raise E11000 instead of a retryable transaction error.
            for (let attempt = 0; ; attempt++) {
                try {
                    return await session.withTransaction(
                        async () => {
                            const existing = await this.db
                                .collection<HazardEvent>(hazardEvents)
                                .findOne<HazardEvent>({ _id: hazardId }, { session, projection: { _id: 0 } });

                            if (existing && this.hasSameContent(existing, input)) {
                                return { hazardEvent: existing, changeType: null };
                            }

                            const now = new Date();
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
                            if (existing) {
                                await this.db
                                    .collection<HazardEvent>(hazardEvents)
                                    .replaceOne({ _id: hazardId }, hazardEvent, { session });
                            } else {
                                await this.db
                                    .collection<HazardEvent>(hazardEvents)
                                    .insertOne({ _id: hazardId, ...hazardEvent }, { session });
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
                                    publishedAt: null,
                                    publishAttempts: 0,
                                    lastError: null,
                                },
                                { session }
                            );
                            return { hazardEvent, changeType };
                        },
                        {
                            readConcern: { level: 'snapshot' },
                            writeConcern: { w: 'majority', j: true },
                            readPreference: 'primary',
                            maxCommitTimeMS: 10_000,
                        }
                    );
                } catch (error) {
                    if (!(error instanceof MongoServerError) || error.code !== 11000 || attempt >= 2) {
                        throw error;
                    }
                }
            }
        } finally {
            await session.endSession();
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
