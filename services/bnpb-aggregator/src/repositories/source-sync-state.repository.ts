import { eq, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import * as schema from '../db/schema';
import { SourceStream, SourceSyncState, SourceSyncStatus, sourceSyncStates } from '../db/schema/source-sync-states';

export interface ISourceSyncStateRepository {
    findAll(): Promise<SourceSyncState[]>;
    findBySourceStream(sourceStream: SourceStream): Promise<SourceSyncState | undefined>;
    recordSuccessfulPoll(sourceStream: SourceStream, at: Date): Promise<SourceSyncState>;
    recordFailedPoll(sourceStream: SourceStream, errorMessage: string, at: Date): Promise<SourceSyncState>;
}

@injectable()
export class SourceSyncStateRepository implements ISourceSyncStateRepository {
    constructor(@inject(TYPES.Database) private readonly db: NodePgDatabase<typeof schema>) {}

    async findAll(): Promise<SourceSyncState[]> {
        return this.db.select().from(sourceSyncStates);
    }

    async findBySourceStream(sourceStream: SourceStream): Promise<SourceSyncState | undefined> {
        const [state] = await this.db.select().from(sourceSyncStates).where(eq(sourceSyncStates.sourceStream, sourceStream));
        return state;
    }

    async recordSuccessfulPoll(sourceStream: SourceStream, at: Date): Promise<SourceSyncState> {
        const [state] = await this.db
            .insert(sourceSyncStates)
            .values({
                sourceStream,
                status: SourceSyncStatus.Healthy,
                lastSuccessfulPollAt: at,
                lastAttemptAt: at,
                staleSince: null,
                lastError: null,
                consecutiveFailures: 0,
            })
            .onConflictDoUpdate({
                target: sourceSyncStates.sourceStream,
                set: {
                    status: SourceSyncStatus.Healthy,
                    lastSuccessfulPollAt: at,
                    lastAttemptAt: at,
                    staleSince: null,
                    lastError: null,
                    consecutiveFailures: 0,
                },
            })
            .returning();
        return state;
    }

    async recordFailedPoll(sourceStream: SourceStream, errorMessage: string, at: Date): Promise<SourceSyncState> {
        const currentState = await this.findBySourceStream(sourceStream);
        const hasSuccessfulPoll = currentState?.lastSuccessfulPollAt !== null && currentState?.lastSuccessfulPollAt !== undefined;
        const status = hasSuccessfulPoll ? SourceSyncStatus.Stale : SourceSyncStatus.Unavailable;
        const staleSince = hasSuccessfulPoll ? (currentState.staleSince ?? at) : null;

        const [state] = await this.db
            .insert(sourceSyncStates)
            .values({
                sourceStream,
                status,
                lastAttemptAt: at,
                staleSince,
                lastError: errorMessage,
                consecutiveFailures: 1,
            })
            .onConflictDoUpdate({
                target: sourceSyncStates.sourceStream,
                set: {
                    status,
                    lastAttemptAt: at,
                    staleSince,
                    lastError: errorMessage,
                    consecutiveFailures: sql`${sourceSyncStates.consecutiveFailures} + 1`,
                },
            })
            .returning();
        return state;
    }
}
