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
                byType: { SEISMIC: 1, VOLCANIC: 0, WILDFIRE: 1, COASTAL: 1, TSUNAMI: 0 },
                byDay: { '2026-01-01': { SEISMIC: 1 }, '2026-01-02': { WILDFIRE: 1, COASTAL: 1 } },
            })
        );
    });

    it('counts warned seismic events in an overlapping tsunami series across streamed batches', async () => {
        const event = (hazardType: string, day: string, warning?: unknown) => ({
            source: 'BMKG',
            hazardType,
            severity: 'SIAGA',
            areaName: 'Aceh',
            occurredAt: new Date(day),
            attributes: { tsunami_warning: warning },
        });
        read.mockImplementation(async (_options, consume) => {
            consume([
                event('SEISMIC', '2026-01-01T23:30:00Z', { warning_id: 'w1', threat_level: 'Siaga' }),
                event('SEISMIC', '2026-01-01T23:59:59Z'),
            ]);
            consume([
                event('SEISMIC', '2026-01-02T00:00:00Z', { warning_id: 'w2', threat_level: 'Awas' }),
                event('COASTAL', '2026-01-02T00:00:00Z', { warning_id: 'not-seismic' }),
                event('SEISMIC', '2026-01-02T00:00:00Z', null),
                event('SEISMIC', '2026-01-02T00:00:00Z', false),
            ]);
            return { partial: false, unavailable_units: [] };
        });
        inspect.mockResolvedValue({ unavailable_units: [] });
        const res = response();
        await controller().analytics({ query: {} } as Request, res);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                total: 6,
                bySource: { BMKG: 6 },
                byMonth: { '2026-01': 6 },
                byType: { SEISMIC: 5, VOLCANIC: 0, WILDFIRE: 0, COASTAL: 1, TSUNAMI: 2 },
                byDay: {
                    '2026-01-01': { SEISMIC: 2, TSUNAMI: 1 },
                    '2026-01-02': { SEISMIC: 3, COASTAL: 1, TSUNAMI: 1 },
                },
                partial: false,
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
