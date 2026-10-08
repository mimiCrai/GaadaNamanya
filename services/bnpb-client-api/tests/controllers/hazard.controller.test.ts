import 'reflect-metadata';
import express from 'express';
import { Container } from 'inversify';
import { InversifyExpressServer } from 'inversify-express-utils';
import request from 'supertest';
import { TYPES } from '../../src/constants/types';
import '../../src/controllers/hazard.controller';
import { IHazardGateway } from '../../src/services/hazard-gateway.service';
import { IJwtAuthenticator } from '../../src/services/jwt-authenticator.service';

describe('HazardController', () => {
    const jwtAuthenticator = {
        authenticate: jest.fn(),
    };
    const hazardGateway = {
        list: jest.fn(),
        getById: jest.fn(),
    };
    let app: express.Application;

    beforeAll(() => {
        const container = new Container();
        container.bind<IJwtAuthenticator>(TYPES.JwtAuthenticator).toConstantValue(jwtAuthenticator);
        container.bind<IHazardGateway>(TYPES.HazardGateway).toConstantValue(hazardGateway);
        app = new InversifyExpressServer(container).build();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('passes the Authorization header to the authenticator and returns public summaries', async () => {
        jwtAuthenticator.authenticate.mockResolvedValue({ sub: 'user-1', sid: 'session-1', role: 'public' });
        hazardGateway.list.mockResolvedValue([
            { Field: 'Bandung', Tipe: 'SEISMIC', Klasifikasi: 'ringkasan', Keterangan: 'Public summary' },
        ]);

        const response = await request(app).get('/hazards').set('Authorization', 'Bearer access-token');

        expect(response.status).toBe(200);
        expect(jwtAuthenticator.authenticate).toHaveBeenCalledWith('Bearer access-token');
        expect(hazardGateway.list).toHaveBeenCalledWith('ringkasan');
        expect(response.body.data).toHaveLength(1);
    });
});
