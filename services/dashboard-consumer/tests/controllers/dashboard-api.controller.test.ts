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
});
