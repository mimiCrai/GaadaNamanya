import 'reflect-metadata';
import express from 'express';
import { Container } from 'inversify';
import request from 'supertest';
import { createApp } from '../../src/app';
import { bindings } from '../../src/config/inversify.config';
import { TYPES } from '../../src/constants/types';

describe('GET /internal-ops/satellite/summary (P4 #2)', () => {
    const jwtAuthenticator = { authenticate: jest.fn() };
    const dlqGateway = { list: jest.fn(), detail: jest.fn(), raw: jest.fn(), replay: jest.fn(), satelliteSummary: jest.fn() };
    let app: express.Application;

    beforeAll(async () => {
        const container = new Container();
        await container.loadAsync(bindings);
        container.rebind(TYPES.JwtAuthenticator).toConstantValue(jwtAuthenticator);
        container.rebind(TYPES.DlqGateway).toConstantValue(dlqGateway);
        app = await createApp(container);
    });
    beforeEach(() => jest.clearAllMocks());

    it.each(['public', 'lapangan'])('answers role %s with 403 without calling the Aggregator', async (role) => {
        jwtAuthenticator.authenticate.mockResolvedValue({ sub: 'u', sid: 's', role });
        const response = await request(app).get('/internal-ops/satellite/summary').set('Authorization', 'Bearer token');
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('forbidden');
        expect(dlqGateway.satelliteSummary).not.toHaveBeenCalled();
    });

    it('proxies the Aggregator summary for role internal', async () => {
        jwtAuthenticator.authenticate.mockResolvedValue({ sub: 'u', sid: 's', role: 'internal' });
        dlqGateway.satelliteSummary.mockResolvedValue({ processor: { single_detections: 4 }, late_detections_stored: 1 });
        const response = await request(app).get('/internal-ops/satellite/summary').set('Authorization', 'Bearer token');
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ processor: { single_detections: 4 }, late_detections_stored: 1 });
    });
});
