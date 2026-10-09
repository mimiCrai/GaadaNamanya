import 'reflect-metadata';
import express from 'express';
import { Container } from 'inversify';
import request from 'supertest';
import { createApp } from '../../src/app';
import { bindings } from '../../src/config/inversify.config';
import { TYPES } from '../../src/constants/types';
import { ApiError } from '../../src/errors/api-error';
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
        hazardGateway.list.mockResolvedValue({
            data: [{ Field: 'Bandung', Tipe: 'SEISMIC', Klasifikasi: 'ringkasan', Keterangan: 'Public summary' }],
            meta: { sources: {} },
        });

        const response = await request(app)
            .get('/hazards')
            .set('Authorization', 'Bearer access-token')
            .set('x-correlation-id', correlationId);

        expect(response.status).toBe(200);
        expect(response.headers['x-correlation-id']).toBe(correlationId);
        expect(jwtAuthenticator.authenticate).toHaveBeenCalledWith('Bearer access-token', correlationId);
        expect(hazardGateway.list).toHaveBeenCalledWith('ringkasan', correlationId, undefined);
        expect(response.body.data).toHaveLength(1);
    });

    it('passes the source filter and returns the freshness metadata', async () => {
        jwtAuthenticator.authenticate.mockResolvedValue({ sub: 'user-1', sid: 'session-1', role: 'public' });
        const freshness = { status: 'STALE', lastSuccessfulPollAt: '2026-10-04T10:00:00.000Z', staleSince: '2026-10-04T10:02:00.000Z' };
        hazardGateway.list.mockResolvedValue({ data: [], meta: { sources: { PVMBG: freshness } } });

        const response = await request(app)
            .get('/hazards?source=PVMBG')
            .set('Authorization', 'Bearer access-token')
            .set('x-correlation-id', correlationId);

        expect(response.status).toBe(200);
        expect(hazardGateway.list).toHaveBeenCalledWith('ringkasan', correlationId, 'PVMBG');
        expect(response.body.meta.sources.PVMBG).toEqual(freshness);
    });

    it('rejects an unknown source before reaching the gateway', async () => {
        const response = await request(app).get('/hazards?source=USGS').set('Authorization', 'Bearer access-token');

        expect(response.status).toBe(400);
        expect(hazardGateway.list).not.toHaveBeenCalled();
    });

    it('answers an upstream timeout with an explicit 504', async () => {
        jwtAuthenticator.authenticate.mockResolvedValue({ sub: 'user-1', sid: 'session-1', role: 'public' });
        hazardGateway.list.mockRejectedValue(new ApiError('BNPB Gateway did not respond in time', 504));

        const response = await request(app).get('/hazards').set('Authorization', 'Bearer access-token');

        expect(response.status).toBe(504);
        expect(response.body.error.message).toBe('BNPB Gateway did not respond in time');
    });
});
