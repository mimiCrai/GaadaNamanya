import 'reflect-metadata';
import express from 'express';
import { Container } from 'inversify';
import request from 'supertest';
import { createApp } from '../../src/app';
import { bindings } from '../../src/config/inversify.config';
import { TYPES } from '../../src/constants/types';
import { ApiError } from '../../src/errors/api-error';

describe('InternalOpsDlqController (P3 #5)', () => {
    const jwtAuthenticator = { authenticate: jest.fn() };
    const dlqGateway = { list: jest.fn(), detail: jest.fn(), raw: jest.fn() };
    let app: express.Application;

    beforeAll(async () => {
        const container = new Container();
        await container.loadAsync(bindings);
        container.rebind(TYPES.JwtAuthenticator).toConstantValue(jwtAuthenticator);
        container.rebind(TYPES.DlqGateway).toConstantValue(dlqGateway);
        app = await createApp(container);
    });
    beforeEach(() => jest.clearAllMocks());

    const paths = [
        '/internal-ops/dlq',
        '/internal-ops/dlq/msg-000000000000000000000001',
        '/internal-ops/dlq/msg-000000000000000000000001/raw',
    ];

    describe.each(['public', 'lapangan'])('role %s (Media / Tim Lapangan)', (role) => {
        it.each(paths)('gets 403 with the standard error body on %s', async (path) => {
            jwtAuthenticator.authenticate.mockResolvedValue({ sub: 'u', sid: 's', role });
            const response = await request(app).get(path).set('Authorization', 'Bearer token');
            expect(response.status).toBe(403);
            expect(response.body).toEqual({
                error: {
                    code: 'forbidden',
                    message: 'Hanya BNPB Internal Ops yang boleh memeriksa pesan yang gagal diproses',
                },
            });
            expect(dlqGateway.list).not.toHaveBeenCalled();
            expect(dlqGateway.detail).not.toHaveBeenCalled();
            expect(dlqGateway.raw).not.toHaveBeenCalled();
        });
    });

    it('rejects missing or invalid tokens with 401', async () => {
        jwtAuthenticator.authenticate.mockRejectedValue(new ApiError('Missing or invalid Authorization header', 401));
        const response = await request(app).get('/internal-ops/dlq').set('Authorization', 'Bearer bad');
        expect(response.status).toBe(401);
    });

    it('lets Internal Ops list and inspect messages', async () => {
        jwtAuthenticator.authenticate.mockResolvedValue({ sub: 'u', sid: 's', role: 'internal' });
        const page = { items: [], next_cursor: null, partial: false, unavailable_units: [] };
        dlqGateway.list.mockResolvedValue(page);
        const list = await request(app)
            .get('/internal-ops/dlq?source=PVMBG&status=parked&limit=10')
            .set('Authorization', 'Bearer ops');
        expect(list.status).toBe(200);
        expect(list.body).toEqual(page);
        expect(dlqGateway.list).toHaveBeenCalledWith(
            { source: 'PVMBG', status: 'parked', limit: '10' },
            expect.any(String)
        );

        const detail = {
            message_id: 'msg-000000000000000000000001',
            payload_base64: Buffer.from([0xff]).toString('base64'),
        };
        dlqGateway.detail.mockResolvedValue(detail);
        const one = await request(app)
            .get('/internal-ops/dlq/msg-000000000000000000000001')
            .set('Authorization', 'Bearer ops');
        expect(one.status).toBe(200);
        expect(one.body).toEqual(detail);
    });

    it('streams raw bytes for Internal Ops', async () => {
        jwtAuthenticator.authenticate.mockResolvedValue({ sub: 'u', sid: 's', role: 'internal' });
        const bytes = Buffer.from([0x7b, 0xc3, 0x28, 0x7d]);
        dlqGateway.raw.mockResolvedValue({
            body: new Response(bytes).body,
            headers: { 'content-type': 'application/octet-stream', 'x-payload-sha256': 'a'.repeat(64) },
        });
        const response = await request(app)
            .get('/internal-ops/dlq/msg-000000000000000000000001/raw')
            .set('Authorization', 'Bearer ops')
            .buffer(true)
            .parse((res, done) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => done(null, Buffer.concat(chunks)));
            });
        expect(response.status).toBe(200);
        expect(Buffer.compare(response.body as Buffer, bytes)).toBe(0);
        expect(response.headers['x-payload-sha256']).toBe('a'.repeat(64));
    });
});
