import { inject, injectable } from 'inversify';
import { createHash } from 'node:crypto';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import { LeaseToken } from '../db/schema/background-leases';
import { SourceStream, SourceSyncState, SourceSyncStatus, sourceSyncStates } from '../db/schema/source-sync-states';
import { SensorStation } from '../clients/sensor-pantai.types';
import env from '../util/env';
import { IBackgroundLeaseRepository } from './background-lease.repository';

export const sensorRejectedMessages = 'sensor_rejected_messages';

export interface SensorSyncState extends SourceSyncState {
    cursor: string | null;
    stations: SensorStation[];
    stationsUpdatedAt: Date | null;
    generatedAt: Date | null;
    latestObservedAt: Date | null;
    sourceProgressAt: Date | null;
    retryAt: Date | null;
}

export interface SensorRejectedMessage {
    messageId: string;
    source: 'SENSOR_PANTAI';
    reason: string;
    payload: unknown;
    receivedAt: Date;
    lastSeenAt: Date;
    correlationId: string;
}

export interface ISensorPantaiRepository {
    getState(): Promise<SensorSyncState>;
    checkpoint(state: SensorSyncState, stale: boolean, lease: LeaseToken): Promise<SensorSyncState>;
    recordFailure(message: string, retryAfterMs: number, lease: LeaseToken): Promise<void>;
    reject(payload: unknown, reason: string, correlationId: string, lease: LeaseToken): Promise<void>;
    rejectBatch(
        records: { payload: unknown; reason: string }[],
        correlationId: string,
        lease: LeaseToken
    ): Promise<void>;
    getRejected(limit: number): Promise<SensorRejectedMessage[]>;
}

@injectable()
export class SensorPantaiRepository implements ISensorPantaiRepository {
    constructor(
        @inject(TYPES.Database) private readonly db: CanonicalStore,
        @inject(TYPES.IBackgroundLeaseRepository) private readonly leases: IBackgroundLeaseRepository
    ) {}

    async getState(): Promise<SensorSyncState> {
        const state = await this.db
            .collection<SensorSyncState>(sourceSyncStates)
            .findOne(
                { _id: SourceStream.SensorPantai },
                { projection: { _id: 0 }, timeoutMS: env.LEASE_OPERATION_TIMEOUT_MS }
            );
        if (!state) throw new Error('Sensor Pantai sync state is missing; run migrations');
        return state;
    }

    async checkpoint(state: SensorSyncState, stale: boolean, lease: LeaseToken): Promise<SensorSyncState> {
        return this.leases.withLease(lease, async (session, at) => {
            const failures = stale ? state.consecutiveFailures + 1 : 0;
            const next = {
                ...state,
                status: stale ? SourceSyncStatus.Stale : SourceSyncStatus.Healthy,
                lastSuccessfulPollAt: at,
                lastAttemptAt: at,
                staleSince: stale ? (state.staleSince ?? at) : null,
                lastError: stale ? 'Sensor Pantai data is not advancing or is behind its source clock' : null,
                consecutiveFailures: failures,
                retryAt:
                    failures >= env.SENSOR_PANTAI_FAILURE_THRESHOLD
                        ? new Date(at.getTime() + env.SENSOR_PANTAI_COOLDOWN_MS)
                        : null,
            };
            await this.db
                .collection<SensorSyncState>(sourceSyncStates)
                .updateOne({ _id: SourceStream.SensorPantai }, { $set: next }, { session });
            return next;
        });
    }

    async recordFailure(message: string, retryAfterMs: number, lease: LeaseToken): Promise<void> {
        await this.leases.withLease(lease, async (session, at) => {
            const previous = await this.db
                .collection<SensorSyncState>(sourceSyncStates)
                .findOne({ _id: SourceStream.SensorPantai }, { session });
            const failures = (previous?.consecutiveFailures ?? 0) + 1;
            const delay = Math.max(
                retryAfterMs,
                failures >= env.SENSOR_PANTAI_FAILURE_THRESHOLD ? env.SENSOR_PANTAI_COOLDOWN_MS : 0
            );
            await this.db.collection<SensorSyncState>(sourceSyncStates).updateOne(
                { _id: SourceStream.SensorPantai },
                {
                    $set: {
                        status: previous?.lastSuccessfulPollAt ? SourceSyncStatus.Stale : SourceSyncStatus.Unavailable,
                        lastAttemptAt: at,
                        lastError: message.slice(0, 1000),
                        consecutiveFailures: failures,
                        staleSince: previous?.lastSuccessfulPollAt ? (previous.staleSince ?? at) : null,
                        retryAt: delay > 0 ? new Date(at.getTime() + delay) : null,
                    },
                },
                { session }
            );
        });
    }

    async reject(payload: unknown, reason: string, correlationId: string, lease: LeaseToken): Promise<void> {
        const messageId = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        await this.leases.withLease(lease, async (session, at) => {
            await this.db.collection<SensorRejectedMessage>(sensorRejectedMessages).updateOne(
                { _id: messageId },
                {
                    $set: { reason, lastSeenAt: at },
                    $setOnInsert: { messageId, source: 'SENSOR_PANTAI', payload, receivedAt: at, correlationId },
                },
                { upsert: true, session }
            );
        });
    }

    async getRejected(limit: number): Promise<SensorRejectedMessage[]> {
        return this.db
            .collection<SensorRejectedMessage>(sensorRejectedMessages)
            .find<SensorRejectedMessage>({}, { projection: { _id: 0 }, timeoutMS: env.LEASE_OPERATION_TIMEOUT_MS })
            .sort({ receivedAt: -1, messageId: 1 })
            .limit(limit)
            .toArray();
    }

    async rejectBatch(
        records: { payload: unknown; reason: string }[],
        correlationId: string,
        lease: LeaseToken
    ): Promise<void> {
        if (!records.length) return;
        if (records.length > 50) throw new Error('Rejected message batches are limited to 50 records');
        await this.leases.withLease(lease, async (session, at) => {
            await this.db.collection<SensorRejectedMessage>(sensorRejectedMessages).bulkWrite(
                records.map(({ payload, reason }) => {
                    const messageId = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
                    return {
                        updateOne: {
                            filter: { _id: messageId },
                            update: {
                                $set: { reason, lastSeenAt: at },
                                $setOnInsert: {
                                    messageId,
                                    source: 'SENSOR_PANTAI' as const,
                                    payload,
                                    receivedAt: at,
                                    correlationId,
                                },
                            },
                            upsert: true,
                        },
                    };
                }),
                { session, ordered: true }
            );
        });
    }
}
