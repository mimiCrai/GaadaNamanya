import 'reflect-metadata';
import { HazardEvent, HazardSeverity, HazardSource, HazardType } from '../../src/db/schema/hazard-events';
import { IHazardEventRepository } from '../../src/repositories/hazard-event.repository';
import { HazardEventService } from '../../src/services/hazard-event.service';
import { ISourceSyncStateService } from '../../src/services/source-sync-state.service';

const mockHazardEventRepository: jest.Mocked<IHazardEventRepository> = {
    findAll: jest.fn(),
    findByHazardId: jest.fn(),
};

const mockSourceSyncStateService: jest.Mocked<ISourceSyncStateService> = {
    getPollingStatus: jest.fn(),
    recordSuccessfulPoll: jest.fn(),
    recordFailedPoll: jest.fn(),
};

describe('HazardEventService', () => {
    let hazardEventService: HazardEventService;

    beforeEach(() => {
        jest.clearAllMocks();
        hazardEventService = new HazardEventService(mockHazardEventRepository, mockSourceSyncStateService);
    });

    it('returns canonical hazard events', async () => {
        const hazardEvents: HazardEvent[] = [
            {
                hazardId: 'hazard_bmkg_bmkg-seismic-1',
                source: HazardSource.Bmkg,
                sourceRefId: 'bmkg-seismic-1',
                hazardType: HazardType.Seismic,
                severity: HazardSeverity.Waspada,
                areaName: 'Jakarta',
                latitude: -6.2,
                longitude: 106.8,
                occurredAt: new Date(),
                ingestedAt: new Date(),
                attributes: {},
            },
        ];
        mockHazardEventRepository.findAll.mockResolvedValue(hazardEvents);

        await expect(hazardEventService.getAllHazardEvents()).resolves.toEqual(hazardEvents);
    });

    it('returns null when a hazard event does not exist', async () => {
        mockHazardEventRepository.findByHazardId.mockResolvedValue(undefined);

        await expect(hazardEventService.getHazardEventById('missing')).resolves.toBeNull();
    });
});
