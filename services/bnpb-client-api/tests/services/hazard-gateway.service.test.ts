import { HazardGateway, classificationForRole } from '../../src/services/hazard-gateway.service';

const correlationId = '22222222-2222-4222-8222-222222222222';

describe('HazardGateway', () => {
    const fetchMock = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = fetchMock;
    });

    const canonicalHazard = {
        hazardId: 'hazard-1', source: 'BMKG', sourceRefId: 'source-1', hazardType: 'SEISMIC', severity: 'WASPADA',
        areaName: 'Bandung', latitude: -6.9175, longitude: 107.6191, occurredAt: '2026-01-01T00:00:00.000Z',
        ingestedAt: '2026-01-01T00:01:00.000Z', attributes: { depth: 10 },
    };

    it('uses the aggregator internal endpoint and produces a public-safe summary', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [canonicalHazard] }), { status: 200, headers: { 'content-type': 'application/json' } }));
        const hazards = await new HazardGateway().list(classificationForRole('public'), correlationId);
        expect(hazards).toHaveLength(1);
        const requestUrl = new URL(fetchMock.mock.calls[0][0] as string);
        expect(requestUrl.pathname).toBe('/internal/hazards');
        expect(fetchMock.mock.calls[0][1]).toMatchObject({
            headers: { 'X-BNPB-Internal-Key': process.env.BNPB_INTERNAL_API_KEY, 'X-Correlation-ID': correlationId },
        });
        expect(hazards[0]).toMatchObject({ Field: 'Bandung', Tipe: 'SEISMIC', Klasifikasi: 'ringkasan' });
        expect(hazards[0].Keterangan).not.toContain('sourceRefId');
    });

    it('returns the raw canonical event only to permitted non-public roles', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: canonicalHazard }), { status: 200, headers: { 'content-type': 'application/json' } }));
        const hazard = await new HazardGateway().getById('hazard-1', classificationForRole('internal'), correlationId);
        const requestUrl = new URL(fetchMock.mock.calls[0][0] as string);
        expect(requestUrl.pathname).toBe('/internal/hazards/hazard-1');
        expect(hazard.Klasifikasi).toBe('mentah');
        expect(JSON.parse(hazard.Keterangan)).toMatchObject({ hazardId: 'hazard-1', attributes: { depth: 10 } });
    });
});
