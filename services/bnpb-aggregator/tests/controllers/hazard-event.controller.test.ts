import 'reflect-metadata';
import express from 'express';
import { Container } from 'inversify';
import { InversifyExpressServer } from 'inversify-express-utils';
import request from 'supertest';
import { TYPES } from '../../src/constants/types';
import { HazardEvent, HazardSeverity, HazardSource, HazardType } from '../../src/db/schema/hazard-events';
import { SourceStream, SourceSyncStatus } from '../../src/db/schema/source-sync-states';
import { InternalAuthMiddleware } from '../../src/middlewares/internal-auth.middleware';
import '../../src/controllers/hazard-event.controller';

const query = { hazards: jest.fn(), hazard: jest.fn() };
const meta = {
    pollingStatus: {
        [SourceStream.PvmbgVolcanic]: {
            status: SourceSyncStatus.Stale,
            lastSuccessfulPollAt: new Date('2026-10-04T10:00:00.000Z'),
            staleSince: new Date('2026-10-04T10:02:00.000Z'),
        },
    },
    partial: false,
    unavailable_units: [],
};

describe('HazardEventController', () => {
    let app: express.Application;

    beforeAll(() => {
        const container = new Container();
        container.bind(TYPES.ICanonicalQueryService).toConstantValue(query);
        container.bind<InternalAuthMiddleware>(TYPES.InternalAuthMiddleware).to(InternalAuthMiddleware);

        app = new InversifyExpressServer(container).build();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        query.hazards.mockResolvedValue({ data: [], meta });
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
        query.hazards.mockResolvedValue({ data: hazardEvents, meta });

        const response = await request(app)
            .get('/internal/hazards')
            .set('X-BNPB-Internal-Key', process.env.BNPB_INTERNAL_API_KEY!);

        expect(response.status).toBe(200);
        expect(response.body.data).toHaveLength(1);
        expect(response.body.meta.pollingStatus[SourceStream.PvmbgVolcanic].status).toBe(SourceSyncStatus.Stale);
        expect(query.hazards).toHaveBeenCalledWith({});
    });

    it('filters hazards by canonical ingestion time', async () => {
        const response = await request(app)
            .get('/internal/hazards?since=2026-10-04T10:00:00.000Z')
            .set('X-BNPB-Internal-Key', process.env.BNPB_INTERNAL_API_KEY!);

        expect(response.status).toBe(200);
        expect(query.hazards).toHaveBeenCalledWith({ since: '2026-10-04T10:00:00.000Z' });
    });

    it('filters hazards by source', async () => {
        const response = await request(app)
            .get('/internal/hazards?source=BMKG')
            .set('X-BNPB-Internal-Key', process.env.BNPB_INTERNAL_API_KEY!);

        expect(response.status).toBe(200);
        expect(response.body.meta.pollingStatus[SourceStream.PvmbgVolcanic].status).toBe(SourceSyncStatus.Stale);
        expect(query.hazards).toHaveBeenCalledWith({ source: HazardSource.Bmkg });
    });

    it('rejects an unknown source', async () => {
        const response = await request(app)
            .get('/internal/hazards?source=USGS')
            .set('X-BNPB-Internal-Key', process.env.BNPB_INTERNAL_API_KEY!);

        expect(response.status).toBe(400);
        expect(response.body.error.message).toContain('source');
        expect(query.hazards).not.toHaveBeenCalled();
    });

    it('rejects an invalid since value', async () => {
        const response = await request(app)
            .get('/internal/hazards?since=yesterday')
            .set('X-BNPB-Internal-Key', process.env.BNPB_INTERNAL_API_KEY!);

        expect(response.status).toBe(400);
        expect(response.body.error.message).toContain('since');
        expect(query.hazards).not.toHaveBeenCalled();
    });

    it('returns 404 when a hazard event does not exist', async () => {
        query.hazard.mockResolvedValue(null);

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
        expect(query.hazards).not.toHaveBeenCalled();
    });

    it('rejects an unrecognised internal API key', async () => {
        const response = await request(app).get('/internal/hazards').set('X-BNPB-Internal-Key', 'wrong-key');

        expect(response.status).toBe(403);
        expect(response.body.error.message).toBe('X-BNPB-Internal-Key is not recognised');
        expect(query.hazards).not.toHaveBeenCalled();
    });
});
