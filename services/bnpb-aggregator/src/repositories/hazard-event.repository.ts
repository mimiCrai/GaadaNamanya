import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inject, injectable } from 'inversify';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TYPES } from '../constants/types';
import * as schema from '../db/schema';
import {
    HazardEvent,
    HazardSource,
    HazardType,
    HazardSeverity,
    hazardEvents,
} from '../db/schema/hazard-events';
import { HazardEventChangeType, outboxEvents } from '../db/schema/outbox-events';

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
    findAll(ingestedSince?: Date): Promise<HazardEvent[]>;
    findByHazardId(hazardId: string): Promise<HazardEvent | undefined>;
    findBySourceAndRefId(source: HazardSource, sourceRefId: string): Promise<HazardEvent | undefined>;
    upsertAndEnqueue(input: UpsertHazardEventInput): Promise<HazardEventUpsertResult>;
}

@injectable()
export class HazardEventRepository implements IHazardEventRepository {
    constructor(@inject(TYPES.Database) private readonly db: NodePgDatabase<typeof schema>) {}

    async findAll(ingestedSince?: Date): Promise<HazardEvent[]> {
        if (ingestedSince) {
            return this.db
                .select()
                .from(hazardEvents)
                .where(gte(hazardEvents.ingestedAt, ingestedSince))
                .orderBy(asc(hazardEvents.ingestedAt), asc(hazardEvents.hazardId));
        }

        return this.db.select().from(hazardEvents).orderBy(desc(hazardEvents.occurredAt));
    }

    async findByHazardId(hazardId: string): Promise<HazardEvent | undefined> {
        const [hazardEvent] = await this.db.select().from(hazardEvents).where(eq(hazardEvents.hazardId, hazardId));
        return hazardEvent;
    }

    async findBySourceAndRefId(source: HazardSource, sourceRefId: string): Promise<HazardEvent | undefined> {
        const [hazardEvent] = await this.db
            .select()
            .from(hazardEvents)
            .where(and(eq(hazardEvents.source, source), eq(hazardEvents.sourceRefId, sourceRefId)));
        return hazardEvent;
    }

    async upsertAndEnqueue(input: UpsertHazardEventInput): Promise<HazardEventUpsertResult> {
        return this.db.transaction(async (tx) => {
            const [existing] = await tx
                .select()
                .from(hazardEvents)
                .where(and(eq(hazardEvents.source, input.source), eq(hazardEvents.sourceRefId, input.sourceRefId)));

            if (existing && this.hasSameContent(existing, input)) {
                return { hazardEvent: existing, changeType: null };
            }

            const ingestedAt = new Date();
            const changeType = existing ? HazardEventChangeType.Updated : HazardEventChangeType.Created;
            const [hazardEvent] = existing
                ? await tx
                      .update(hazardEvents)
                      .set({
                          hazardType: input.hazardType,
                          severity: input.severity,
                          areaName: input.areaName,
                          latitude: input.latitude,
                          longitude: input.longitude,
                          occurredAt: input.occurredAt,
                          ingestedAt,
                          attributes: input.attributes,
                      })
                      .where(eq(hazardEvents.hazardId, existing.hazardId))
                      .returning()
                : await tx
                      .insert(hazardEvents)
                      .values({
                          hazardId: randomUUID(),
                          source: input.source,
                          sourceRefId: input.sourceRefId,
                          hazardType: input.hazardType,
                          severity: input.severity,
                          areaName: input.areaName,
                          latitude: input.latitude,
                          longitude: input.longitude,
                          occurredAt: input.occurredAt,
                          ingestedAt,
                          attributes: input.attributes,
                      })
                      .returning();

            const outboxEventId = randomUUID();
            await tx.insert(outboxEvents).values({
                outboxEventId,
                aggregateId: hazardEvent.hazardId,
                eventType: changeType,
                topic: input.topic,
                partitionKey: hazardEvent.hazardId,
                payload: {
                    eventId: outboxEventId,
                    eventType: changeType,
                    correlationId: input.correlationId,
                    hazard: this.toEventPayload(hazardEvent),
                },
            });

            return { hazardEvent, changeType };
        });
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
