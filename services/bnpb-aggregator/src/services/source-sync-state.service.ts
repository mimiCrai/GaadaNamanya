import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { SourceStream, SourceSyncState, SourceSyncStatus } from '../db/schema/source-sync-states';
import { ISourceSyncStateRepository } from '../repositories/source-sync-state.repository';
import { LeaseToken } from '../db/schema/background-leases';

export interface PollingStatus {
    status: SourceSyncStatus;
    lastSuccessfulPollAt: Date | null;
    staleSince: Date | null;
}

export interface ISourceSyncStateService {
    getPollingStatus(): Promise<Record<string, PollingStatus>>;
    getState(sourceStream: SourceStream): Promise<SourceSyncState | undefined>;
    recordSuccessfulPoll(sourceStream: SourceStream, at: Date, lease: LeaseToken): Promise<void>;
    recordFailedPoll(sourceStream: SourceStream, error: unknown, at: Date, lease: LeaseToken): Promise<void>;
}

@injectable()
export class SourceSyncStateService implements ISourceSyncStateService {
    constructor(
        @inject(TYPES.ISourceSyncStateRepository) private readonly sourceSyncStateRepository: ISourceSyncStateRepository
    ) {}

    async getPollingStatus(): Promise<Record<string, PollingStatus>> {
        const states = await this.sourceSyncStateRepository.findAll();
        return Object.fromEntries(
            states.map((state) => [
                state.sourceStream,
                {
                    status: state.status,
                    lastSuccessfulPollAt: state.lastSuccessfulPollAt,
                    staleSince: state.staleSince,
                },
            ])
        );
    }

    async getState(sourceStream: SourceStream): Promise<SourceSyncState | undefined> {
        return this.sourceSyncStateRepository.findBySourceStream(sourceStream);
    }

    async recordSuccessfulPoll(sourceStream: SourceStream, at: Date, lease: LeaseToken): Promise<void> {
        await this.sourceSyncStateRepository.recordSuccessfulPoll(sourceStream, at, lease);
    }

    async recordFailedPoll(sourceStream: SourceStream, error: unknown, at: Date, lease: LeaseToken): Promise<void> {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await this.sourceSyncStateRepository.recordFailedPoll(sourceStream, errorMessage, at, lease);
    }
}
