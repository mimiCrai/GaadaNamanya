import 'reflect-metadata';
import request from 'supertest';
import { Database } from '../../src/db';
import { HealthService } from '../../src/services/health.service';
import { buildApp } from '../helpers';

describe('HealthController', () => {
    it('returns 200 without credentials while the database answers', async () => {
        const { app } = await buildApp();
        const response = await request(app).get('/health');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            status: 'ok',
            service: 'bmkg',
            database: 'connected',
            uptime_s: expect.any(Number),
            time: expect.any(String),
        });
    });

    it('reports an error when the database is unreachable', async () => {
        const unreachable = { execute: () => Promise.reject(new Error('connection refused')) } as unknown as Database;

        const health = await new HealthService(unreachable).check();

        expect(health).toEqual(expect.objectContaining({ status: 'error', database: 'disconnected' }));
    });
});
