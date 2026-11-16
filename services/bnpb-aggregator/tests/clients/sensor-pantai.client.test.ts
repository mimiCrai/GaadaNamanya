import { SensorPantaiClient } from '../../src/clients/sensor-pantai.client';
import { SensorClientError } from '../../src/clients/sensor-pantai.types';
import env from '../../src/util/env';

describe('SensorPantaiClient', () => {
    const options = { correlationId: 'request-1', instanceId: 'owner-1', fencingToken: 7 };
    const fetchMock = jest.fn();
    const originalFetch = global.fetch;
    const originalLimit = env.SENSOR_PANTAI_MAX_RESPONSE_BYTES;
    const validPage = { generated_at: '2026-11-12T00:00:00Z', items: [], next_cursor: null };
    beforeEach(() => {
        fetchMock.mockReset();
        global.fetch = fetchMock;
        env.SENSOR_PANTAI_MAX_RESPONSE_BYTES = originalLimit;
    });
    afterAll(() => {
        global.fetch = originalFetch;
        env.SENSOR_PANTAI_MAX_RESPONSE_BYTES = originalLimit;
    });

    it('sends the source credential and tracing headers and preserves the opaque cursor', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify(validPage)));
        const result = await new SensorPantaiClient().getObservations('opaque/+?cursor', options);
        const [url, request] = fetchMock.mock.calls[0];
        expect(new URL(url).searchParams.get('cursor')).toBe('opaque/+?cursor');
        expect(request.headers).toMatchObject({
            Authorization: `Bearer ${env.SENSOR_PANTAI_TOKEN}`,
            'X-Correlation-ID': 'request-1',
            'X-BNPB-Fence': '7',
        });
        expect(result.nextCursor).toBeNull();
    });

    it('honours bounded Retry-After without reading an error response as data', async () => {
        fetchMock.mockResolvedValue(new Response('busy', { status: 429, headers: { 'Retry-After': '3' } }));
        await expect(new SensorPantaiClient().getObservations(null, options)).rejects.toMatchObject({
            status: 429,
            retryAfterMs: 3000,
        });
    });

    it.each([
        ['truncated JSON', '{"items":'],
        ['deep nesting', '['.repeat(21) + '0' + ']'.repeat(21)],
        ['invalid envelope', JSON.stringify({ items: [], next_cursor: null })],
    ])('rejects and retains the bytes for %s', async (_label, body) => {
        fetchMock.mockResolvedValue(new Response(body));
        await expect(new SensorPantaiClient().getObservations(null, options)).rejects.toMatchObject({
            rawBody: Buffer.from(body).toString('base64'),
        });
    });

    it('rejects invalid UTF-8 instead of silently replacing bytes', async () => {
        fetchMock.mockResolvedValue(new Response(new Uint8Array([0xc3, 0x28])));
        await expect(new SensorPantaiClient().getObservations(null, options)).rejects.toBeInstanceOf(SensorClientError);
    });

    it('bounds a response even without a content-length header', async () => {
        env.SENSOR_PANTAI_MAX_RESPONSE_BYTES = 32;
        fetchMock.mockResolvedValue(new Response('x'.repeat(100)));
        await expect(new SensorPantaiClient().getObservations(null, options)).rejects.toMatchObject({
            rawBody: Buffer.from('x'.repeat(32)).toString('base64'),
            truncated: true,
        });
    });

    it('validates station coordinates', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    items: [
                        { station_id: 'station', name: 'Coast', province: 'Province', latitude: 999, longitude: 100 },
                    ],
                })
            )
        );
        await expect(new SensorPantaiClient().getStations(options)).rejects.toThrow('Invalid station');
    });

    it('allows braces inside strings without treating them as deep objects', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...validPage, extra: '{'.repeat(100) })));
        await expect(new SensorPantaiClient().getObservations(null, options)).resolves.toMatchObject({ items: [] });
    });
});
