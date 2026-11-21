import env from '../../src/util/env';
import request from 'supertest';
import { createApp } from '../../src/app';
import { Request, Response } from 'express';
import { DashboardApiController } from '../../src/controllers/dashboard-api.controller';
import { DashboardHazard } from '../../src/db/schema/dashboard-hazards';
import { IDashboardProjectionService } from '../../src/services/dashboard-projection.service';

describe('DashboardApiController', () => {
    it('returns the dashboard service projection as data', async () => {
        const hazards: DashboardHazard[] = [
            {
                hazardId: '33333333-3333-4333-8333-333333333333',
                source: 'BMKG',
                hazardType: 'SEISMIC',
                severity: 'SIAGA',
                areaName: 'Aceh',
                attributes: { magnitude: 6.8, potential_tsunami: true },
                occurredAt: new Date('2026-10-04T10:00:00.000Z'),
                lastEventId: '11111111-1111-4111-8111-111111111111',
                lastEventType: 'hazard.created',
                updatedAt: new Date('2026-10-04T10:00:01.000Z'),
            },
        ];
        const projectionService: IDashboardProjectionService = {
            apply: jest.fn(),
            getHazards: jest.fn().mockResolvedValue(hazards),
        };
        const response = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        } as unknown as Response;
        const controller = new DashboardApiController(projectionService);

        await controller.getHazards({} as Request, response);

        expect(response.status).toHaveBeenCalledWith(200);
        expect(response.json).toHaveBeenCalledWith({ data: hazards });
    });

    it('summarizes the historical projection by source, severity, type, and month', async () => {
        const hazard = {
            hazardId: '33333333-3333-4333-8333-333333333333',
            source: 'BMKG',
            hazardType: 'SEISMIC',
            severity: 'SIAGA',
            areaName: 'Aceh',
            attributes: {},
            occurredAt: new Date('2026-10-04T10:00:00.000Z'),
            lastEventId: '11111111-1111-4111-8111-111111111111',
            lastEventType: 'hazard.created',
            updatedAt: new Date('2026-10-04T10:00:01.000Z'),
        } as DashboardHazard;
        const service: IDashboardProjectionService = {
            apply: jest.fn(),
            getHazards: jest.fn().mockResolvedValue([
                hazard,
                {
                    ...hazard,
                    hazardId: 'other',
                    source: 'SENSOR_PANTAI',
                    hazardType: 'COASTAL',
                    severity: 'AWAS',
                },
            ]),
        };
        const response = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
        await new DashboardApiController(service).getAnalytics({} as Request, response);
        expect(response.json).toHaveBeenCalledWith({
            partial: true,
            unavailable_units: ['canonical-analytics-not-configured'],
            degraded: true,
            total: 2,
            bySource: { BMKG: 1, SENSOR_PANTAI: 1 },
            bySeverity: { SIAGA: 1, AWAS: 1 },
            byType: { SEISMIC: 1, COASTAL: 1 },
            byMonth: { '2026-10': 2 },
        });
    });
});

describe('Canonical analytics proxy', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch;
        delete env.CANONICAL_ANALYTICS_URL;
        delete env.BNPB_INTERNAL_API_KEY;
    });
    it('passes the time range and internal key to the owner, retaining partial flags', async () => {
        env.CANONICAL_ANALYTICS_URL = 'http://owner:3000/internal/analytics';
        env.BNPB_INTERNAL_API_KEY = 'private-key';
        global.fetch = jest
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({ total: 2, partial: true }) });
        const service = { getHazards: jest.fn() } as unknown as IDashboardProjectionService;
        const res = { json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response;
        await new DashboardApiController(service).getAnalytics(
            { query: { from: '2026-01-01T00:00:00Z' } } as unknown as Request,
            res
        );
        expect(res.json).toHaveBeenCalledWith({ total: 2, partial: true });
        expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('from=2026-01-01');
        expect(service.getHazards).not.toHaveBeenCalled();
    });
    it('accepts the browser time range through the actual OpenAPI middleware', async () => {
        env.CANONICAL_ANALYTICS_URL = 'http://owner:3000/internal/analytics';
        const analytics = {
            total: 2,
            partial: false,
            byType: { SEISMIC: 2, TSUNAMI: 1 },
            byDay: { '2000-01-01': { SEISMIC: 2, TSUNAMI: 1 } },
        };
        global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => analytics });
        const response = await request(await createApp())
            .get('/api/hazards/analytics')
            .query({ from: '2000-01-01T00:00:00Z' });
        expect(response.status).toBe(200);
        expect(response.body).toEqual(analytics);
    });
    it('returns 503 with explicit incompleteness when the owner cannot be reached', async () => {
        env.CANONICAL_ANALYTICS_URL = 'http://owner:3000/internal/analytics';
        global.fetch = jest.fn().mockRejectedValue(new Error('timeout'));
        const res = { json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response;
        await new DashboardApiController({} as IDashboardProjectionService).getAnalytics({ query: {} } as Request, res);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ partial: true, degraded: true }));
    });
});
