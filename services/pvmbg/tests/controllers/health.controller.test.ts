import 'reflect-metadata';
import request from 'supertest';
import { buildApp } from '../helpers';

describe('HealthController', () => {
    const { app } = buildApp();

    it('returns 200 without credentials', async () => {
        const response = await request(app).get('/health');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            status: 'ok',
            service: 'pvmbg',
            uptime_s: expect.any(Number),
            time: expect.any(String),
        });
    });
});
