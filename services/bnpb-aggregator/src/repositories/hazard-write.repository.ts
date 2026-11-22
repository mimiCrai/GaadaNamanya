import { inject, injectable } from 'inversify';
import { ClientSession, MongoServerError } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import { HazardTombstone, hazardTombstones } from '../db/schema/fire-processor';
import { HazardEvent, HazardSeverity, HazardSource, HazardType, hazardEvents } from '../db/schema/hazard-events';
import { HazardEventChangeType, OutboxEvent, outboxEvents } from '../db/schema/outbox-events';
import { captureTrace } from '../telemetry/context';
import env from '../util/env';
import { canonicalHazardId } from './hazard-event.repository';

export interface HazardWriteContent {
    hazardType: HazardType;
    severity: HazardSeverity;
    areaName: string;
    latitude: number;
    longitude: number;
    occurredAt: Date;
    attributes: Record<string, unknown>;
}

export type HazardWriteOp =
    | { op: 'upsert'; source: HazardSource; sourceRefId: string; version: number; hazard: HazardWriteContent }
    | { op: 'delete'; source: HazardSource; sourceRefId: string; version: number };

// applied = stored and enqueued; unchanged = idempotent repeat; skipped = an equal-or-newer version is stored
export type HazardWriteOutcome = 'applied' | 'unchanged' | 'skipped';

export interface HazardWriteResult {
    op: HazardWriteOp['op'];
    sourceRefId: string;
    hazardId: string;
    result: HazardWriteOutcome;
    changeType: HazardEventChangeType | null;
}

export interface IHazardWriteRepository {
    apply(op: HazardWriteOp, correlationId: string): Promise<HazardWriteResult>;
}

// feed offsets as fixed-width strings so the shared string `version` field compares numerically
export const feedVersion = (offset: number): string => offset.toString().padStart(16, '0');

type StoredHazardEvent = HazardEvent & { version?: string };

export function sameHazardContent(existing: HazardEvent, incoming: HazardWriteContent): boolean {
    return (
        existing.hazardType === incoming.hazardType &&
        existing.severity === incoming.severity &&
        existing.areaName === incoming.areaName &&
        existing.latitude === incoming.latitude &&
        existing.longitude === incoming.longitude &&
        existing.occurredAt.getTime() === incoming.occurredAt.getTime() &&
        isDeepStrictEqual(existing.attributes, incoming.attributes)
    );
}

const eventPayload = (event: HazardEvent): Record<string, unknown> => ({
    ...event,
    occurredAt: event.occurredAt.toISOString(),
    ingestedAt: event.ingestedAt.toISOString(),
});

// Usulan 3.4: lease-free fire processor writes, fenced by version guard + tombstone, one transaction per _id
@injectable()
export class HazardWriteRepository implements IHazardWriteRepository {
    constructor(@inject(TYPES.Database) private readonly db: CanonicalStore) {}

    async apply(op: HazardWriteOp, correlationId: string): Promise<HazardWriteResult> {
        const hazardId = canonicalHazardId(op.source, op.sourceRefId);
        const version = feedVersion(op.version);
        const traceContext = captureTrace();
        // concurrent first inserts (hazard or tombstone) can raise E11000 instead of a transient error
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.inTransaction(async (session) => {
                    const base = { op: op.op, sourceRefId: op.sourceRefId, hazardId };
                    const tombstone = await this.db
                        .collection<HazardTombstone>(hazardTombstones)
                        .findOne({ _id: hazardId }, { session });
                    if (tombstone && version < tombstone.version) return { ...base, result: 'skipped', changeType: null };
                    const stored = await this.db
                        .collection<StoredHazardEvent>(hazardEvents)
                        .findOne<StoredHazardEvent>({ _id: hazardId }, { session, projection: { _id: 0 } });
                    if (stored?.version !== undefined && version < stored.version) {
                        return { ...base, result: 'skipped', changeType: null };
                    }
                    const outcome =
                        op.op === 'upsert'
                            ? await this.upsert(session, op, hazardId, version, stored, correlationId, traceContext)
                            : await this.delete(session, op, hazardId, version, stored, correlationId, traceContext);
                    return { ...base, ...outcome };
                });
            } catch (error) {
                if (!(error instanceof MongoServerError) || error.code !== 11000 || attempt >= 2) throw error;
            }
        }
    }

    private async upsert(
        session: ClientSession,
        op: Extract<HazardWriteOp, { op: 'upsert' }>,
        hazardId: string,
        version: string,
        stored: StoredHazardEvent | null,
        correlationId: string,
        traceContext: Record<string, string>
    ): Promise<Pick<HazardWriteResult, 'result' | 'changeType'>> {
        const collection = this.db.collection<StoredHazardEvent>(hazardEvents);
        const existing = stored ? withoutVersion(stored) : null;
        if (existing && sameHazardContent(existing, op.hazard)) {
            if (stored!.version !== version) {
                await collection.updateOne({ _id: hazardId }, { $set: { version } }, { session });
            }
            return { result: 'unchanged', changeType: null };
        }
        const hazardEvent: HazardEvent = {
            hazardId,
            source: op.source,
            sourceRefId: op.sourceRefId,
            ...op.hazard,
            ingestedAt: new Date(),
        };
        const document: StoredHazardEvent = { ...hazardEvent, version };
        if (existing) {
            const guard = { $or: [{ version: { $exists: false } }, { version: { $lte: version } }] };
            const replaced = await collection.replaceOne({ _id: hazardId, ...guard }, document, { session });
            if (replaced.matchedCount !== 1) return { result: 'skipped', changeType: null };
        } else {
            await collection.insertOne({ _id: hazardId, ...document }, { session });
        }
        const changeType = existing ? HazardEventChangeType.Updated : HazardEventChangeType.Created;
        await this.enqueue(session, hazardEvent, changeType, correlationId, traceContext);
        return { result: 'applied', changeType };
    }

    private async delete(
        session: ClientSession,
        op: Extract<HazardWriteOp, { op: 'delete' }>,
        hazardId: string,
        version: string,
        stored: StoredHazardEvent | null,
        correlationId: string,
        traceContext: Record<string, string>
    ): Promise<Pick<HazardWriteResult, 'result' | 'changeType'>> {
        await this.db.collection<HazardTombstone>(hazardTombstones).updateOne(
            { _id: hazardId },
            {
                $set: { source: op.source, sourceRefId: op.sourceRefId, deletedAt: new Date(), correlationId },
                $max: { version },
            },
            { session, upsert: true }
        );
        if (!stored) return { result: 'unchanged', changeType: null };
        const guard = { $or: [{ version: { $exists: false } }, { version: { $lte: version } }] };
        const deleted = await this.db
            .collection<StoredHazardEvent>(hazardEvents)
            .deleteOne({ _id: hazardId, ...guard }, { session });
        if (deleted.deletedCount !== 1) return { result: 'skipped', changeType: null };
        // the last stored state travels with hazard.deleted so consumers know what disappeared
        await this.enqueue(session, withoutVersion(stored), HazardEventChangeType.Deleted, correlationId, traceContext);
        return { result: 'applied', changeType: HazardEventChangeType.Deleted };
    }

    private async enqueue(
        session: ClientSession,
        hazardEvent: HazardEvent,
        changeType: HazardEventChangeType,
        correlationId: string,
        traceContext: Record<string, string>
    ): Promise<void> {
        const outboxEventId = randomUUID();
        await this.db.collection<OutboxEvent>(outboxEvents).insertOne(
            {
                _id: outboxEventId,
                outboxEventId,
                aggregateId: hazardEvent.hazardId,
                eventType: changeType,
                topic: env.KAFKA_TOPIC,
                partitionKey: hazardEvent.hazardId,
                payload: { eventId: outboxEventId, eventType: changeType, correlationId, hazard: eventPayload(hazardEvent) },
                createdAt: new Date(),
                ...(Object.keys(traceContext).length ? { traceContext } : {}),
                publishedAt: null,
                publishAttempts: 0,
                lastError: null,
            },
            { session }
        );
    }

    private async inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
        const session = this.db.client.startSession();
        try {
            return await session.withTransaction(() => work(session), {
                readConcern: { level: 'snapshot' },
                writeConcern: { w: 'majority', j: true },
                readPreference: 'primary',
                maxCommitTimeMS: env.LEASE_OPERATION_TIMEOUT_MS,
                timeoutMS: env.LEASE_OPERATION_TIMEOUT_MS,
            });
        } finally {
            await session.endSession();
        }
    }
}

function withoutVersion(stored: StoredHazardEvent): HazardEvent {
    const { version: _version, ...event } = stored;
    return event;
}
