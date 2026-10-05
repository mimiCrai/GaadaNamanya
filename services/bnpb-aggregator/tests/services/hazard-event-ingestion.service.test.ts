import 'reflect-metadata';
import { SeismicEvent, TsunamiWarning, VolcanicReport } from '../../src/clients/source-client.types';
import { HazardEvent, HazardSeverity, HazardSource, HazardType } from '../../src/db/schema/hazard-events';
import { HazardEventChangeType } from '../../src/db/schema/outbox-events';
import { HazardEventUpsertResult, IHazardEventRepository } from '../../src/repositories/hazard-event.repository';
import { IPendingTsunamiWarningRepository } from '../../src/repositories/pending-tsunami-warning.repository';
import { HazardEventIngestionService } from '../../src/services/hazard-event-ingestion.service';

const hazardEvent: HazardEvent = {
    hazardId: 'hazard-1',
    source: HazardSource.Bmkg,
    sourceRefId: 'seismic-1',
    hazardType: HazardType.Seismic,
    severity: HazardSeverity.Normal,
    areaName: 'West Java',
    latitude: -6.9,
    longitude: 107.6,
    occurredAt: new Date('2026-10-04T00:00:00.000Z'),
    ingestedAt: new Date('2026-10-04T00:00:01.000Z'),
    attributes: { magnitude: 5.2 },
};

const createdResult: HazardEventUpsertResult = {
    hazardEvent,
    changeType: HazardEventChangeType.Created,
};

const mockHazardEventRepository: jest.Mocked<IHazardEventRepository> = {
    findAll: jest.fn(),
    findByHazardId: jest.fn(),
    findBySourceAndRefId: jest.fn(),
    upsertAndEnqueue: jest.fn(),
};

const mockPendingWarningRepository: jest.Mocked<IPendingTsunamiWarningRepository> = {
    findOldest: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
};

describe('HazardEventIngestionService', () => {
    let service: HazardEventIngestionService;

    beforeEach(() => {
        jest.clearAllMocks();
        mockHazardEventRepository.upsertAndEnqueue.mockResolvedValue(createdResult);
        mockPendingWarningRepository.findOldest.mockResolvedValue([]);
        service = new HazardEventIngestionService(mockHazardEventRepository, mockPendingWarningRepository);
    });

    it('preserves additive PVMBG fields in canonical attributes', async () => {
        const report: VolcanicReport = {
            report_id: 'volcanic-1',
            volcano_id: 'Merapi',
            alert_level: 'Siaga',
            eruption_count_24h: 12,
            ash_column_height_m: 2500,
            reported_at: '2026-10-04T00:00:00.000Z',
            confidence_level: 0.91,
        };

        await service.ingestVolcanicReports([report], 'correlation-1');

        expect(mockHazardEventRepository.upsertAndEnqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                source: HazardSource.Pvmbg,
                sourceRefId: 'volcanic-1',
                hazardType: HazardType.Volcanic,
                severity: HazardSeverity.Siaga,
                areaName: 'Gunung Merapi',
                latitude: -7.5407,
                longitude: 110.4457,
                attributes: {
                    eruption_count_24h: 12,
                    ash_column_height_m: 2500,
                    confidence_level: 0.91,
                },
                correlationId: 'correlation-1',
            })
        );
    });

    it('maps seismic magnitude to the required severity before a tsunami warning exists', async () => {
        const event: SeismicEvent = {
            event_id: 'seismic-2',
            magnitude: 5.8,
            depth_km: 15,
            epicenter_lat: -6.9,
            epicenter_lon: 107.6,
            region_name: 'West Java',
            occurred_at: '2026-10-04T00:00:00.000Z',
            potential_tsunami: false,
        };

        await service.ingestSeismicEvents([event], 'correlation-seismic');

        expect(mockHazardEventRepository.upsertAndEnqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                source: HazardSource.Bmkg,
                sourceRefId: 'seismic-2',
                severity: HazardSeverity.Waspada,
            })
        );
    });

    it('enriches the linked seismic hazard when a tsunami warning arrives', async () => {
        const warning: TsunamiWarning = {
            warning_id: 'warning-1',
            related_event_id: 'seismic-1',
            threat_level: 'Awas',
            affected_zones: ['Coast A'],
            estimated_arrival: '2026-10-04T00:30:00.000Z',
        };
        mockHazardEventRepository.findBySourceAndRefId.mockResolvedValue(hazardEvent);
        mockHazardEventRepository.upsertAndEnqueue.mockResolvedValue({
            hazardEvent: { ...hazardEvent, severity: HazardSeverity.Awas },
            changeType: HazardEventChangeType.Updated,
        });

        await service.ingestTsunamiWarnings([warning], 'correlation-2');

        expect(mockHazardEventRepository.upsertAndEnqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                sourceRefId: 'seismic-1',
                severity: HazardSeverity.Awas,
                attributes: expect.objectContaining({
                    tsunami_warning: expect.objectContaining({ warning_id: 'warning-1' }),
                }),
            })
        );
        expect(mockPendingWarningRepository.save).not.toHaveBeenCalled();
    });

    it('stores a tsunami warning durably when its seismic event is not present yet', async () => {
        const warning: TsunamiWarning = {
            warning_id: 'warning-2',
            related_event_id: 'not-yet-ingested',
            threat_level: 'Waspada',
            affected_zones: ['Coast B'],
            estimated_arrival: '2026-10-04T00:30:00.000Z',
        };
        mockHazardEventRepository.findBySourceAndRefId.mockResolvedValue(undefined);

        await service.ingestTsunamiWarnings([warning], 'correlation-3');

        expect(mockPendingWarningRepository.save).toHaveBeenCalledWith(warning);
    });
});
