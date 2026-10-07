import 'reflect-metadata';
import request from 'supertest';
import express from 'express';
import { Container } from 'inversify';
import { InversifyExpressServer } from 'inversify-express-utils';
import { TYPES } from '../../src/constants/types';
import { IHealthService } from '../../src/services/health.service';

import '../../src/controllers/health.controller';

const mockHealthService = {
    check: jest.fn(),
    liveness: jest.fn(),
    readiness: jest.fn(),
};

describe('HealthController', () => {
    let app: express.Application;

    beforeAll(() => {
        const container = new Container();
        container
            .bind<IHealthService>(TYPES.IHealthService)
            .toConstantValue(mockHealthService as unknown as IHealthService);

        const server = new InversifyExpressServer(container);
        app = server.build();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /health', () => {
        it('should return 200 when service is healthy', async () => {
            mockHealthService.check.mockResolvedValue({
                status: 'healthy',
                timestamp: '2024-01-01T00:00:00.000Z',
                services: { database: 'connected' },
            });

            const response = await request(app).get('/health');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('healthy');
            expect(response.body.services.database).toBe('connected');
        });

        it('should return 503 when service is unhealthy', async () => {
            mockHealthService.check.mockResolvedValue({
                status: 'unhealthy',
                timestamp: '2024-01-01T00:00:00.000Z',
                services: { database: 'disconnected' },
            });

            const response = await request(app).get('/health');

            expect(response.status).toBe(503);
            expect(response.body.status).toBe('unhealthy');
        });
    });

    describe('GET /health/live', () => {
        it('should return 200 with ok status', async () => {
            mockHealthService.liveness.mockResolvedValue({ status: 'ok' });

            const response = await request(app).get('/health/live');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('ok');
        });
    });

    describe('GET /health/ready', () => {
        it('should return 200 when ready', async () => {
            mockHealthService.readiness.mockResolvedValue({ status: 'ok' });

            const response = await request(app).get('/health/ready');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('ok');
        });

        it('should return 503 when not ready', async () => {
            mockHealthService.readiness.mockResolvedValue({ status: 'error' });

            const response = await request(app).get('/health/ready');

            expect(response.status).toBe(503);
            expect(response.body.status).toBe('error');
        });
    });
});
