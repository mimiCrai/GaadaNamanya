import { Request, Response } from 'express';
import { AnalyticsController } from '../../src/controllers/analytics.controller';
import { ICanonicalReadRepository } from '../../src/repositories/canonical-read.repository';
import { IStorageTopologyService } from '../../src/services/storage-topology.service';

describe('Canonical analytics', () => {
    const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() }) as unknown as Response;
    const inspect = jest.fn();
    const read = jest.fn();
    const controller = () =>
        new AnalyticsController(
            { read } as ICanonicalReadRepository,
            { inspect } as unknown as IStorageTopologyService
        );
    beforeEach(() => jest.resetAllMocks());

    it('streams all types and areas and distinguishes a missing replica from missing data', async () => {
        read.mockImplementation(async (_options, consume) => {
            consume([
                {
                    source: 'BMKG',
                    hazardType: 'SEISMIC',
                    severity: 'SIAGA',
                    areaName: 'Aceh',
                    occurredAt: new Date('2026-01-01Z'),
                },
                {
                    source: 'SATELIT',
                    hazardType: 'WILDFIRE',
                    severity: 'AWAS',
                    areaName: 'Riau',
                    occurredAt: new Date('2026-01-02Z'),
                },
                {
                    source: 'SENSOR_PANTAI',
                    hazardType: 'COASTAL',
                    severity: 'NORMAL',
                    areaName: 'Aceh',
                    occurredAt: new Date('2026-01-02Z'),
                },
            ]);
            return { items: [], partial: false, unavailable_units: [] };
        });
        inspect.mockResolvedValue({ unavailable_units: [], degraded_units: ['canonical-shard-a/member-2'] });
        const res = response();
        await controller().analytics(
            { query: { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' } } as unknown as Request,
            res
        );
        expect(read.mock.calls[0][0].filter).toEqual({
            occurredAt: { $gte: new Date('2026-01-01Z'), $lt: new Date('2026-02-01Z') },
        });
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                total: 3,
                partial: false,
                degraded: true,
                byArea: { Aceh: 2, Riau: 1 },
                byType: { SEISMIC: 1, VOLCANIC: 0, WILDFIRE: 1, COASTAL: 1 },
                byDay: { '2026-01-01': { SEISMIC: 1 }, '2026-01-02': { WILDFIRE: 1, COASTAL: 1 } },
            })
        );
    });

    it('labels incomplete shard counts as partial', async () => {
        read.mockResolvedValue({ items: [], partial: true, unavailable_units: ['canonical-shard-b'] });
        inspect.mockResolvedValue({ unavailable_units: ['canonical-shard-b'] });
        const res = response();
        await controller().analytics({ query: {} } as Request, res);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({ partial: true, degraded: true, unavailable_units: ['canonical-shard-b'] })
        );
    });

    it('rejects reversed time ranges before reading storage', async () => {
        const res = response();
        await controller().analytics(
            { query: { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' } } as unknown as Request,
            res
        );
        expect(res.status).toHaveBeenCalledWith(400);
        expect(read).not.toHaveBeenCalled();
    });
});
