import 'reflect-metadata';
import { Writable } from 'stream';
import { Application } from 'express';
import request from 'supertest';
import { createLogger } from '../../src/libs/logger';
import { BMKG_KEY, buildApp } from '../helpers';

const CORRELATION_ID = '7d3f6c1e-2b4a-4c8d-9e0f-1a2b3c4d5e6f';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('X-Correlation-ID', () => {
    let app: Application;
    beforeAll(async () => ({ app } = await buildApp()));

    it.each([
        ['a successful poll', '/seismic-events', 200],
        ['an auth failure', '/tsunami-warnings', 401],
        ['an unknown route', '/volcanic-reports', 404],
    ])('echoes the incoming ID on %s', async (_case, path, status) => {
        const req = request(app).get(path).set('X-Correlation-ID', CORRELATION_ID);
        const response = await (status === 200 ? req.set('X-BMKG-Key', BMKG_KEY) : req);

        expect(response.status).toBe(status);
        expect(response.headers['x-correlation-id']).toBe(CORRELATION_ID);
    });

    it.each([undefined, 'not-a-uuid'])('generates a UUID v4 when the header is %s', async (header) => {
        const req = request(app).get('/health');
        const response = await (header === undefined ? req : req.set('X-Correlation-ID', header));

        expect(response.headers['x-correlation-id']).toMatch(UUID_V4);
    });

    it('logs the request with its correlation ID and never logs the key', async () => {
        const lines: string[] = [];
        const stream = new Writable({
            write(chunk, _encoding, callback) {
                lines.push(chunk.toString());
                callback();
            },
        });
        const { app: loggedApp } = await buildApp(createLogger({ stream }));

        await request(loggedApp)
            .get('/seismic-events')
            .set('X-BMKG-Key', BMKG_KEY)
            .set('X-Correlation-ID', CORRELATION_ID);

        const requestLog = lines.map((line) => JSON.parse(line)).find((log) => log.msg === 'Request completed');
        expect(requestLog).toEqual(
            expect.objectContaining({
                service: 'bmkg',
                correlation_id: CORRELATION_ID,
                method: 'GET',
                path: '/seismic-events',
                status: 200,
                latency_ms: expect.any(Number),
                injected_delay_ms: 0,
                auth_result: 'ok',
            })
        );
        expect(lines.join('')).not.toContain(BMKG_KEY);
    });
});
