import 'reflect-metadata';
import express from 'express';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Container } from 'inversify';
import request from 'supertest';
import { createApp } from '../../src/app';
import { bindings } from '../../src/config/inversify.config';
import { TYPES } from '../../src/constants/types';
import { ApiError } from '../../src/errors/api-error';
import { IHazardGateway } from '../../src/services/hazard-gateway.service';
import { UserRole } from '../../src/types/auth';
import env from '../../src/util/env';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const payload = { data: [], meta: { sources: {} } };

function accessToken(role: UserRole, expiry = Math.floor(Date.now() / 1000) + 60): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
        JSON.stringify({ sub: 'user-id', sid: 'session-id', role, type: 'access', exp: expiry })
    ).toString('base64url');
    const signed = `${header}.${body}`;
    return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url')}`;
}

function deferred() {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

describe('Hazard admission over HTTP with verified JWT roles', () => {
    let app: express.Application;
    let pending: ReturnType<typeof deferred>[];
    let requests: Promise<request.Response>[];
    let waiters: { count: number; resolve: () => void }[];
    const gateway = { list: jest.fn(), getById: jest.fn() };

    function hold() {
        const next = deferred();
        pending.push(next);
        for (const waiter of waiters) if (pending.length >= waiter.count) waiter.resolve();
        return next.promise;
    }

    function entered(count: number) {
        return new Promise<void>((resolve) => {
            if (pending.length >= count) resolve();
            else waiters.push({ count, resolve });
        });
    }

    function start(role: UserRole, path = '/hazards', headers: Record<string, string> = {}) {
        const result = request(app)
            .get(path)
            .set('Authorization', `Bearer ${accessToken(role)}`)
            .set(headers)
            .then((res) => res);
        requests.push(result);
        return result;
    }

    beforeEach(async () => {
        pending = [];
        requests = [];
        waiters = [];
        jest.replaceProperty(env, 'ADMISSION_MAX_CONCURRENT_REQUESTS', 2);
        jest.replaceProperty(env, 'ADMISSION_RESERVED_LAPANGAN_REQUESTS', 1);
        jest.replaceProperty(env, 'ADMISSION_RETRY_AFTER_SECONDS', 2);
        jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(publicPem));
        gateway.list.mockReset().mockImplementation(hold);
        gateway.getById.mockReset().mockImplementation(hold);
        const container = new Container();
        await container.loadAsync(bindings);
        container.rebind<IHazardGateway>(TYPES.HazardGateway).toConstantValue(gateway);
        app = await createApp(container);
    });

    afterEach(async () => {
        for (const work of pending) work.resolve(payload);
        await Promise.allSettled(requests);
        jest.restoreAllMocks();
    });

    it('shares one budget across list/detail, reserves Lapangan capacity, and bounds all roles', async () => {
        const media = start('public');
        await entered(1);
        const rejected = await start('public', '/hazards/hazard-1');
        expect(rejected.status).toBe(503);
        expect(rejected.headers['retry-after']).toBe('2');
        expect(rejected.headers['x-correlation-id']).toBeDefined();
        expect(rejected.body).toEqual({ error: { message: 'Service Unavailable' } });
        expect((await start('internal')).status).toBe(503);
        expect(gateway.getById).not.toHaveBeenCalled();
        expect(gateway.list).toHaveBeenCalledTimes(1);

        const field = start('lapangan', '/hazards/hazard-1');
        await entered(2);
        expect(gateway.getById).toHaveBeenCalledWith('hazard-1', 'mentah', expect.any(String));
        expect((await start('lapangan')).status).toBe(503);
        pending.forEach((work) => work.resolve(payload));
        expect((await media).status).toBe(200);
        expect((await field).status).toBe(200);
        const metrics = await request(app).get('/metrics').expect(200);
        for (const role of ['public', 'lapangan', 'internal']) {
            expect(metrics.text).toContain(`status_code="503",role="${role}"`);
        }
    });

    it('does not let a public token claim reserved capacity through role headers', async () => {
        start('public');
        await entered(1);
        const response = await start('public', '/hazards', { 'X-Role': 'lapangan', 'X-User-Role': 'lapangan' });
        expect(response.status).toBe(503);
        expect(gateway.list).toHaveBeenCalledTimes(1);
        const field = start('lapangan');
        await entered(2);
        pending[1].resolve(payload);
        expect((await field).status).toBe(200);
    });

    it('reuses shared capacity after a successful request completes', async () => {
        const first = start('public');
        await entered(1);
        pending[0].resolve(payload);
        expect((await first).status).toBe(200);
        const second = start('internal', '/hazards/hazard-1');
        await entered(2);
        pending[1].resolve(payload);
        expect((await second).status).toBe(200);
    });

    it.each(['/hazards', '/hazards/hazard-1'])('releases capacity after an upstream timeout on %s', async (path) => {
        const first = start('public', path);
        await entered(1);
        pending[0].reject(new ApiError('Upstream timed out', 504));
        expect((await first).status).toBe(504);
        const second = start('public');
        await entered(2);
        pending[1].resolve(payload);
        expect((await second).status).toBe(200);
    });

    it('releases capacity after an unexpected upstream failure', async () => {
        const first = start('public');
        await entered(1);
        pending[0].reject(new Error('Unexpected failure'));
        expect((await first).status).toBe(500);
        const second = start('public');
        await entered(2);
        pending[1].resolve(payload);
        expect((await second).status).toBe(200);
    });

    it.each(['missing', 'expired', 'forged'])('rejects a %s token before admission even when full', async (kind) => {
        start('public');
        await entered(1);
        start('lapangan');
        await entered(2);
        const req = request(app).get('/hazards');
        if (kind === 'expired') req.set('Authorization', `Bearer ${accessToken('lapangan', 1)}`);
        if (kind === 'forged') {
            const [header, body, signature] = accessToken('lapangan').split('.');
            req.set(
                'Authorization',
                `Bearer ${header}.${body}.${signature.startsWith('a') ? 'b' : 'a'}${signature.slice(1)}`
            );
        }
        expect((await req).status).toBe(401);
        expect(gateway.list).toHaveBeenCalledTimes(2);
    });

    it('keeps liveness accessible while all hazard slots are occupied', async () => {
        start('public');
        await entered(1);
        start('lapangan');
        await entered(2);
        expect((await request(app).get('/health/live')).status).toBe(200);
    });
});
