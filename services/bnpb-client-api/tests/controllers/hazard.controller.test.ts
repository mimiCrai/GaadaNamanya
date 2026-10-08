import 'reflect-metadata';
import express from 'express';
import { Container } from 'inversify';
import request from 'supertest';
import { createApp } from '../../src/app';
import { bindings } from '../../src/config/inversify.config';
import { TYPES } from '../../src/constants/types';
import { IHazardGateway } from '../../src/services/hazard-gateway.service';
import { IJwtAuthenticator } from '../../src/services/jwt-authenticator.service';

const correlationId = '11111111-1111-4111-8111-111111111111';

describe('HazardController', () => {
    const jwtAuthenticator = {
        authenticate: jest.fn(),
    };
    const hazardGateway = {
        list: jest.fn(),
        getById: jest.fn(),
    };
    let app: express.Application;

    beforeAll(async () => {
        const container = new Container();
        await container.loadAsync(bindings);
        container.rebind<IJwtAuthenticator>(TYPES.JwtAuthenticator).toConstantValue(jwtAuthenticator);
        container.rebind<IHazardGateway>(TYPES.HazardGateway).toConstantValue(hazardGateway);
        app = await createApp(container);
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('passes the Authorization header to the authenticator and returns public summaries', async () => {
        jwtAuthenticator.authenticate.mockResolvedValue({ sub: 'user-1', sid: 'session-1', role: 'public' });
        hazardGateway.list.mockResolvedValue([
            { Field: 'Bandung', Tipe: 'SEISMIC', Klasifikasi: 'ringkasan', Keterangan: 'Public summary' },
        ]);

        const response = await request(app)
            .get('/hazards')
            .set('Authorization', 'Bearer access-token')
            .set('x-correlation-id', correlationId);

        expect(response.status).toBe(200);
        expect(response.headers['x-correlation-id']).toBe(correlationId);
        expect(jwtAuthenticator.authenticate).toHaveBeenCalledWith('Bearer access-token', correlationId);
        expect(hazardGateway.list).toHaveBeenCalledWith('ringkasan', correlationId);
        expect(response.body.data).toHaveLength(1);
    });
});
