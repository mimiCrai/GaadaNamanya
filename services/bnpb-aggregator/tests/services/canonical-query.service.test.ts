import { HazardEvent } from '../../src/db/schema/hazard-events';
import { ICanonicalReadRepository } from '../../src/repositories/canonical-read.repository';
import { CanonicalQueryService } from '../../src/services/canonical-query.service';
import { IStorageTopologyService } from '../../src/services/storage-topology.service';

describe('CanonicalQueryService', () => {
    const read = jest.fn();
    const topology = { inspect: jest.fn(), locate: jest.fn(), close: jest.fn() };
    let service: CanonicalQueryService;
    const row = (id: string) =>
        ({
            hazardId: id,
            source: 'BMKG',
            sourceRefId: `source-${id}`,
            hazardType: 'SEISMIC',
            severity: 'NORMAL',
            areaName: 'Bandung',
            latitude: -6.9,
            longitude: 107.6,
            occurredAt: new Date('2026-01-01T00:00:00Z'),
            ingestedAt: new Date('2026-01-02T00:00:00Z'),
            attributes: {},
        }) as HazardEvent;
    const complete = (items: HazardEvent[]) => ({ items, partial: false, unavailable_units: [] });

    beforeEach(() => {
        jest.resetAllMocks();
        service = new CanonicalQueryService({ read } as ICanonicalReadRepository, topology as IStorageTopologyService);
    });

    it('requires pagination to restart when a shard disappears between pages', async () => {
        read.mockResolvedValueOnce(complete([row('a'), row('b')]));
        const first = await service.events({ limit: 1 });
        read.mockResolvedValueOnce({ items: [row('b')], partial: true, unavailable_units: ['canonical-shard-b'] });

        await expect(service.events({ limit: 1, cursor: first.next_cursor as string })).rejects.toMatchObject({
            status: 400,
            code: 'bad_request',
            message: expect.stringContaining('restart pagination'),
        });
    });

    it('requires pagination to restart when a missing shard recovers between pages', async () => {
        read.mockResolvedValueOnce({
            items: [row('a'), row('b')],
            partial: true,
            unavailable_units: ['canonical-shard-b'],
        });
        const first = await service.events({ limit: 1 });
        read.mockResolvedValueOnce(complete([row('b')]));

        await expect(service.events({ limit: 1, cursor: first.next_cursor as string })).rejects.toMatchObject({
            status: 400,
        });
    });

    it('orders the latest-hazard page globally by occurrence time with an ascending ID tie breaker', async () => {
        read.mockResolvedValue(complete([]));

        await service.hazards({ limit: 50 });

        expect(read).toHaveBeenCalledWith(
            expect.objectContaining({
                collection: 'hazard_events',
                sort: { occurredAt: -1, hazardId: 1 },
                limit: 51,
            })
        );
    });

    it('does not return 404 when an unavailable shard could contain the requested hazard', async () => {
        read.mockResolvedValue({ items: [], partial: true, unavailable_units: ['canonical-shard-b'] });

        await expect(service.hazard('unknown')).resolves.toMatchObject({
            data: null,
            meta: { partial: true, unavailable_units: ['canonical-shard-b'] },
        });
        await expect(service.location('unknown')).resolves.toMatchObject({
            hazard_id: 'unknown',
            locations: [],
            partial: true,
            unavailable_units: ['canonical-shard-b'],
        });
        expect(topology.locate).not.toHaveBeenCalled();
    });

    it('marks failed location metadata incomplete without discarding the known hazard identity', async () => {
        read.mockResolvedValue(complete([row('a')]));
        topology.inspect.mockResolvedValue({ shards: [], primaries: {}, unavailable_units: [] });
        topology.locate.mockRejectedValue(new Error('metadata unavailable'));

        await expect(service.location('a')).resolves.toEqual({
            hazard_id: 'a',
            locations: [],
            partial: true,
            unavailable_units: ['canonical-metadata'],
        });
    });
});
