import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import { SourceStream, SourceSyncState, SourceSyncStatus, sourceSyncStates } from '../db/schema/source-sync-states';

export interface ISourceSyncStateRepository {
    findAll(): Promise<SourceSyncState[]>;
    findBySourceStream(sourceStream: SourceStream): Promise<SourceSyncState | undefined>;
    recordSuccessfulPoll(sourceStream: SourceStream, at: Date): Promise<SourceSyncState>;
    recordFailedPoll(sourceStream: SourceStream, errorMessage: string, at: Date): Promise<SourceSyncState>;
}

@injectable()
export class SourceSyncStateRepository implements ISourceSyncStateRepository {
    constructor(@inject(TYPES.Database) private readonly db: CanonicalStore) {}

    async findAll(): Promise<SourceSyncState[]> {
        return this.db
            .collection<SourceSyncState>(sourceSyncStates)
            .find<SourceSyncState>({}, { projection: { _id: 0 } })
            .toArray();
    }

    async findBySourceStream(sourceStream: SourceStream): Promise<SourceSyncState | undefined> {
        return (
            (await this.db
                .collection<SourceSyncState>(sourceSyncStates)
                .findOne<SourceSyncState>({ _id: sourceStream }, { projection: { _id: 0 } })) ?? undefined
        );
    }

    async recordSuccessfulPoll(sourceStream: SourceStream, at: Date): Promise<SourceSyncState> {
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
                },
            },
            { upsert: true, returnDocument: 'after', projection: { _id: 0 } }
        ))!;
    }

    async recordFailedPoll(sourceStream: SourceStream, errorMessage: string, at: Date): Promise<SourceSyncState> {
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
            { upsert: true, returnDocument: 'after', projection: { _id: 0 } }
        ))!;
    }
}
