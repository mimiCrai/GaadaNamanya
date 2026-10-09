import 'reflect-metadata';
import express from 'express';
import { Container } from 'inversify';
import { InversifyExpressServer } from 'inversify-express-utils';
import request from 'supertest';
import { TYPES } from '../../src/constants/types';
import { HazardEvent, HazardSeverity, HazardSource, HazardType } from '../../src/db/schema/hazard-events';
import { SourceStream, SourceSyncStatus } from '../../src/db/schema/source-sync-states';
import { IHazardEventService } from '../../src/services/hazard-event.service';
import { InternalAuthMiddleware } from '../../src/middlewares/internal-auth.middleware';
import '../../src/controllers/hazard-event.controller';

const mockHazardEventService = {
    getAllHazardEvents: jest.fn(),
    getHazardEventById: jest.fn(),
    getPollingStatus: jest.fn(),
};

describe('HazardEventController', () => {
    let app: express.Application;

    beforeAll(() => {
        const container = new Container();
        container
            .bind<IHazardEventService>(TYPES.IHazardEventService)
            .toConstantValue(mockHazardEventService as IHazardEventService);
        container.bind<InternalAuthMiddleware>(TYPES.InternalAuthMiddleware).to(InternalAuthMiddleware);

        app = new InversifyExpressServer(container).build();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockHazardEventService.getPollingStatus.mockResolvedValue({
            [SourceStream.PvmbgVolcanic]: {
                status: SourceSyncStatus.Stale,
                lastSuccessfulPollAt: new Date('2026-10-04T10:00:00.000Z'),
                staleSince: new Date('2026-10-04T10:02:00.000Z'),
            },
        });
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
        mockHazardEventService.getAllHazardEvents.mockResolvedValue(hazardEvents);

        const response = await request(app)
            .get('/internal/hazards')
            .set('X-BNPB-Internal-Key', process.env.BNPB_INTERNAL_API_KEY!);

        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(1);
        expect(response.body.meta.pollingStatus[SourceStream.PvmbgVolcanic].status).toBe(SourceSyncStatus.Stale);
        expect(mockHazardEventService.getAllHazardEvents).toHaveBeenCalledWith(undefined, undefined);
    });

    it('filters hazards by canonical ingestion time', async () => {
        mockHazardEventService.getAllHazardEvents.mockResolvedValue([]);

        const response = await request(app)
            .get('/internal/hazards?since=2026-10-04T10:00:00.000Z')
            .set('X-BNPB-Internal-Key', process.env.BNPB_INTERNAL_API_KEY!);

        expect(response.status).toBe(200);
        expect(mockHazardEventService.getAllHazardEvents).toHaveBeenCalledWith(
            new Date('2026-10-04T10:00:00.000Z'),
            undefined
        );
    });

    it('filters hazards by source', async () => {
        mockHazardEventService.getAllHazardEvents.mockResolvedValue([]);

        const response = await request(app)
            .get('/internal/hazards?source=BMKG')
            .set('X-BNPB-Internal-Key', process.env.BNPB_INTERNAL_API_KEY!);

        expect(response.status).toBe(200);
        expect(response.body.meta.pollingStatus[SourceStream.PvmbgVolcanic].status).toBe(SourceSyncStatus.Stale);
        expect(mockHazardEventService.getAllHazardEvents).toHaveBeenCalledWith(undefined, HazardSource.Bmkg);
    });

    it('rejects an unknown source', async () => {
        const response = await request(app)
            .get('/internal/hazards?source=USGS')
            .set('X-BNPB-Internal-Key', process.env.BNPB_INTERNAL_API_KEY!);

        expect(response.status).toBe(400);
        expect(response.body.error.message).toBe('source must be BMKG or PVMBG');
        expect(mockHazardEventService.getAllHazardEvents).not.toHaveBeenCalled();
    });

    it('rejects an invalid since value', async () => {
        const response = await request(app)
            .get('/internal/hazards?since=yesterday')
            .set('X-BNPB-Internal-Key', process.env.BNPB_INTERNAL_API_KEY!);

        expect(response.status).toBe(400);
        expect(response.body.error.message).toBe('since must be an ISO 8601 timestamp');
        expect(mockHazardEventService.getAllHazardEvents).not.toHaveBeenCalled();
    });

    it('returns 404 when a hazard event does not exist', async () => {
        mockHazardEventService.getHazardEventById.mockResolvedValue(null);

        const response = await request(app)
            .get('/internal/hazards/missing')
            .set('X-BNPB-Internal-Key', process.env.BNPB_INTERNAL_API_KEY!);

        expect(response.status).toBe(404);
        expect(response.body.error.message).toBe('Hazard event not found');
    });

    it('rejects a request without the internal API key', async () => {
        const response = await request(app).get('/internal/hazards');

        expect(response.status).toBe(401);
        expect(response.body.error.message).toBe('X-BNPB-Internal-Key header is required');
        expect(mockHazardEventService.getAllHazardEvents).not.toHaveBeenCalled();
    });

    it('rejects an unrecognised internal API key', async () => {
        const response = await request(app).get('/internal/hazards').set('X-BNPB-Internal-Key', 'wrong-key');

        expect(response.status).toBe(403);
        expect(response.body.error.message).toBe('X-BNPB-Internal-Key is not recognised');
        expect(mockHazardEventService.getAllHazardEvents).not.toHaveBeenCalled();
    });
});
