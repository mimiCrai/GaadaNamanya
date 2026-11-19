import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import { createApp, createContainer } from '../../src/app';
import { TYPES } from '../../src/constants/types';

/** Full app (OpenAPI validator + internal key middleware) in front of /internal/satellite/*. */
describe('Satellite internal routes through the full app', () => {
    const ingest = { start: jest.fn(), stop: jest.fn(), status: jest.fn(), disconnect: jest.fn() };
    const key = process.env.BNPB_INTERNAL_API_KEY as string;
    let app: express.Application;

    beforeAll(async () => {
        const container = await createContainer();
        container.rebind(TYPES.ISatelliteIngestService).toConstantValue(ingest);
        app = await createApp(container);
    });

    it('returns the ingest status of this instance', async () => {
        const status = {
            enabled: true,
            leader: true,
            connected: true,
            last_offset_durable: 41,
            reconnects: { gap: 1 },
        };
        ingest.status.mockReturnValue(status);
        const result = await request(app).get('/internal/satellite/status').set('X-BNPB-Internal-Key', key);
        expect(result.status).toBe(200);
        expect(result.body).toEqual(status);
    });

    it('drops the stream on request, 409 when this instance holds none', async () => {
        ingest.disconnect.mockReturnValueOnce(true).mockReturnValueOnce(false);
        const dropped = await request(app).post('/internal/satellite/disconnect').set('X-BNPB-Internal-Key', key);
        expect(dropped.status).toBe(202);
        const none = await request(app).post('/internal/satellite/disconnect').set('X-BNPB-Internal-Key', key);
        expect(none.status).toBe(409);
        expect(none.body.error.code).toBe('conflict');
    });

    it('requires the internal key', async () => {
        expect((await request(app).get('/internal/satellite/status')).status).toBe(401);
        expect(
            (await request(app).post('/internal/satellite/disconnect').set('X-BNPB-Internal-Key', 'x'.repeat(40)))
                .status
        ).toBe(403);
        expect(ingest.disconnect).toHaveBeenCalledTimes(2);
    });
});
