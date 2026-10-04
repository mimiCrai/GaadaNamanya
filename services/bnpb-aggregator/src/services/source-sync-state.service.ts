import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { SourceStream, SourceSyncStatus } from '../db/schema/source-sync-states';
import { ISourceSyncStateRepository } from '../repositories/source-sync-state.repository';

export interface PollingStatus {
    status: SourceSyncStatus;
    lastSuccessfulPollAt: Date | null;
    staleSince: Date | null;
}

export interface ISourceSyncStateService {
    getPollingStatus(): Promise<Record<string, PollingStatus>>;
    recordSuccessfulPoll(sourceStream: SourceStream): Promise<void>;
    recordFailedPoll(sourceStream: SourceStream, error: unknown): Promise<void>;
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

    async recordSuccessfulPoll(sourceStream: SourceStream): Promise<void> {
        await this.sourceSyncStateRepository.recordSuccessfulPoll(sourceStream, new Date());
    }

    async recordFailedPoll(sourceStream: SourceStream, error: unknown): Promise<void> {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await this.sourceSyncStateRepository.recordFailedPoll(sourceStream, errorMessage, new Date());
    }
}
