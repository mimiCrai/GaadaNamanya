import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import { SourceStream, SourceSyncState, SourceSyncStatus, sourceSyncStates } from '../db/schema/source-sync-states';
import { LeaseToken } from '../db/schema/background-leases';
import { IBackgroundLeaseRepository } from './background-lease.repository';

export interface ISourceSyncStateRepository {
    findAll(): Promise<SourceSyncState[]>;
    findBySourceStream(sourceStream: SourceStream): Promise<SourceSyncState | undefined>;
    recordSuccessfulPoll(sourceStream: SourceStream, at: Date, lease: LeaseToken): Promise<SourceSyncState>;
    recordFailedPoll(
        sourceStream: SourceStream,
        errorMessage: string,
        at: Date,
        lease: LeaseToken
    ): Promise<SourceSyncState>;
    recordHeldBodyFailure(sourceStream: SourceStream, lease: LeaseToken): Promise<number>;
}

@injectable()
export class SourceSyncStateRepository implements ISourceSyncStateRepository {
    constructor(
        @inject(TYPES.Database) private readonly db: CanonicalStore,
        @inject(TYPES.IBackgroundLeaseRepository) private readonly leases: IBackgroundLeaseRepository
    ) {}

    async findAll(): Promise<SourceSyncState[]> {
        return this.db
            .collection<SourceSyncState>(sourceSyncStates)
            .find<SourceSyncState>({}, { projection: { _id: 0 } })
            .sort({ sourceStream: 1 })
            .toArray();
    }

    async findBySourceStream(sourceStream: SourceStream): Promise<SourceSyncState | undefined> {
        return (
            (await this.db
                .collection<SourceSyncState>(sourceSyncStates)
                .findOne<SourceSyncState>({ _id: sourceStream }, { projection: { _id: 0 } })) ?? undefined
        );
    }

    async recordSuccessfulPoll(sourceStream: SourceStream, at: Date, lease: LeaseToken): Promise<SourceSyncState> {
        return this.leases.withLease(lease, async (session) => {
            return (await this.db.collection<SourceSyncState>(sourceSyncStates).findOneAndUpdate(
                { _id: sourceStream },
                {
                    $set: {
                        sourceStream,
                        status: SourceSyncStatus.Healthy,
                        lastSuccessfulPollAt: at,
                        lastAttemptAt: at,
                        staleSince: null,
                        lastError: null,
                        consecutiveFailures: 0,
                        consecutiveBodyFailures: 0,
                    },
                },
                { upsert: true, session, returnDocument: 'after', projection: { _id: 0 } }
            ))!;
        });
    }

    async recordFailedPoll(
        sourceStream: SourceStream,
        errorMessage: string,
        at: Date,
        lease: LeaseToken
    ): Promise<SourceSyncState> {
        return this.leases.withLease(lease, async (session) => {
            return (await this.db.collection<SourceSyncState>(sourceSyncStates).findOneAndUpdate(
                { _id: sourceStream },
                [
                    {
                        $set: {
                            sourceStream: { $literal: sourceStream },
                            status: {
                                $cond: [
                                    { $ne: [{ $ifNull: ['$lastSuccessfulPollAt', null] }, null] },
                                    SourceSyncStatus.Stale,
                                    SourceSyncStatus.Unavailable,
                                ],
                            },
                            lastSuccessfulPollAt: { $ifNull: ['$lastSuccessfulPollAt', null] },
                            lastAttemptAt: at,
                            staleSince: {
                                $cond: [
                                    { $ne: [{ $ifNull: ['$lastSuccessfulPollAt', null] }, null] },
                                    { $ifNull: ['$staleSince', at] },
                                    null,
                                ],
                            },
                            lastError: { $literal: errorMessage },
                            consecutiveFailures: { $add: [{ $ifNull: ['$consecutiveFailures', 0] }, 1] },
                        },
                    },
                ],
                { upsert: true, session, returnDocument: 'after', projection: { _id: 0 } }
            ))!;
        });
    }

    // D-34: counts only held whole-body failures; other failures leave it untouched (PERLU DIKONFIRMASI KE A/B)
    async recordHeldBodyFailure(sourceStream: SourceStream, lease: LeaseToken): Promise<number> {
        return this.leases.withLease(lease, async (session) => {
            const state = await this.db
                .collection<SourceSyncState>(sourceSyncStates)
                .findOneAndUpdate(
                    { _id: sourceStream },
                    { $inc: { consecutiveBodyFailures: 1 } },
                    { upsert: true, session, returnDocument: 'after', projection: { _id: 0 } }
                );
            return state?.consecutiveBodyFailures ?? 1;
        });
    }
}
