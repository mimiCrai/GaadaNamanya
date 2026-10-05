import 'reflect-metadata';
import { SourceStream, SourceSyncState, SourceSyncStatus } from '../../src/db/schema/source-sync-states';
import { ISourceSyncStateRepository } from '../../src/repositories/source-sync-state.repository';
import { SourceSyncStateService } from '../../src/services/source-sync-state.service';

const mockSourceSyncStateRepository: jest.Mocked<ISourceSyncStateRepository> = {
    findAll: jest.fn(),
    findBySourceStream: jest.fn(),
    recordSuccessfulPoll: jest.fn(),
    recordFailedPoll: jest.fn(),
};

describe('SourceSyncStateService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('exposes stale status separately from canonical hazard data', async () => {
        const states: SourceSyncState[] = [
            {
                sourceStream: SourceStream.PvmbgVolcanic,
                status: SourceSyncStatus.Stale,
                lastSuccessfulPollAt: new Date('2026-10-04T10:00:00.000Z'),
                lastAttemptAt: new Date('2026-10-04T10:02:00.000Z'),
                staleSince: new Date('2026-10-04T10:02:00.000Z'),
                lastError: 'PVMBG request timed out',
                consecutiveFailures: 1,
            },
        ];
        mockSourceSyncStateRepository.findAll.mockResolvedValue(states);
        const service = new SourceSyncStateService(mockSourceSyncStateRepository);

        await expect(service.getPollingStatus()).resolves.toEqual({
            [SourceStream.PvmbgVolcanic]: {
                status: SourceSyncStatus.Stale,
                lastSuccessfulPollAt: states[0].lastSuccessfulPollAt,
                staleSince: states[0].staleSince,
            },
        });
    });
});
