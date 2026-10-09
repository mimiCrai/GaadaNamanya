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
        const { data: hazards } = await new HazardGateway().list(classificationForRole('public'), correlationId);
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
        const { data: hazard } = await new HazardGateway().getById('hazard-1', classificationForRole('internal'), correlationId);
        const requestUrl = new URL(fetchMock.mock.calls[0][0] as string);
        expect(requestUrl.pathname).toBe('/internal/hazards/hazard-1');
        expect(hazard.Klasifikasi).toBe('mentah');
        expect(JSON.parse(hazard.Keterangan)).toMatchObject({ hazardId: 'hazard-1', attributes: { depth: 10 } });
    });

    const pollingStatus = {
        BMKG_SEISMIC: { status: 'HEALTHY', lastSuccessfulPollAt: '2026-10-04T10:05:00.000Z', staleSince: null },
        BMKG_TSUNAMI_WARNING: { status: 'HEALTHY', lastSuccessfulPollAt: '2026-10-04T10:04:00.000Z', staleSince: null },
        PVMBG_VOLCANIC: {
            status: 'STALE',
            lastSuccessfulPollAt: '2026-10-04T10:00:00.000Z',
            staleSince: '2026-10-04T10:02:00.000Z',
        },
    };

    function jsonResponse(body: unknown, status = 200) {
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }

    it('forwards the source filter and reports only that provider freshness', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ data: [], meta: { pollingStatus } }));

        const result = await new HazardGateway().list('ringkasan', correlationId, 'PVMBG');

        const requestUrl = new URL(fetchMock.mock.calls[0][0] as string);
        expect(requestUrl.searchParams.get('source')).toBe('PVMBG');
        expect(result.meta.sources).toEqual({
            PVMBG: {
                status: 'STALE',
                lastSuccessfulPollAt: '2026-10-04T10:00:00.000Z',
                staleSince: '2026-10-04T10:02:00.000Z',
            },
        });
    });

    it('summarises every provider from its least healthy stream when unfiltered', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ data: [canonicalHazard], meta: { pollingStatus } }));

        const result = await new HazardGateway().list('ringkasan', correlationId);

        expect(new URL(fetchMock.mock.calls[0][0] as string).searchParams.has('source')).toBe(false);
        expect(result.meta.sources.BMKG).toEqual({
            status: 'HEALTHY',
            lastSuccessfulPollAt: '2026-10-04T10:04:00.000Z',
            staleSince: null,
        });
        expect(result.meta.sources.PVMBG?.status).toBe('STALE');
    });

    it('treats a provider missing from the polling status as unavailable', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ data: [] }));

        const result = await new HazardGateway().list('ringkasan', correlationId, 'BMKG');

        expect(result.meta.sources.BMKG).toEqual({ status: 'UNAVAILABLE', lastSuccessfulPollAt: null, staleSince: null });
    });

    it('reports the freshness of the hazard source on a single read', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ data: canonicalHazard, meta: { pollingStatus } }));

        const result = await new HazardGateway().getById('hazard-1', 'ringkasan', correlationId);

        expect(Object.keys(result.meta.sources)).toEqual(['BMKG']);
    });

    it('turns an Aggregator timeout into an explicit 504', async () => {
        fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

        await expect(new HazardGateway().list('ringkasan', correlationId)).rejects.toMatchObject({ status: 504 });
        expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it('turns an unreachable Aggregator into a 502', async () => {
        fetchMock.mockRejectedValue(new TypeError('fetch failed'));

        await expect(new HazardGateway().list('ringkasan', correlationId)).rejects.toMatchObject({ status: 502 });
    });
});
