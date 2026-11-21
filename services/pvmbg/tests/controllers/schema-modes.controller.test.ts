import 'reflect-metadata';
import { isUtf8 } from 'buffer';
import http from 'http';
import { AddressInfo } from 'net';
import { Application } from 'express';
import request from 'supertest';
import { VolcanicReportV1Schema, VolcanicReportV2Schema } from '../../src/types/contract';
import { buildApp, PVMBG_TOKEN } from '../helpers';

const AUTH = `Bearer ${PVMBG_TOKEN}`;
const post = (app: Application, path: string, body: object) =>
    request(app).post(`/admin${path}`).set('Authorization', AUTH).send(body);
const rawGet = (app: Application) =>
    request(app)
        .get('/volcanic-reports')
        .set('Authorization', AUTH)
        .buffer(true)
        .parse((res, done) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => done(null, Buffer.concat(chunks)));
        });
const listById = async (app: Application) => {
    const body = (await request(app).get('/volcanic-reports').set('Authorization', AUTH)).body;
    return new Map<string, Record<string, unknown>>(body.data.map((r: Record<string, unknown>) => [r.report_id, r]));
};

describe('M1 regression: POST /admin/schema-version {version}', () => {
    it.each([1, 2])('answers {version:%i} with exactly {schema_version, changed_at}', async (version) => {
        const { app } = await buildApp();
        const response = await post(app, '/schema-version', { version });

        expect(response.status).toBe(200);
        expect(Object.keys(response.body).sort()).toEqual(['changed_at', 'schema_version']);
        expect(response.body.schema_version).toBe(version);
    });

    it('keeps the M1 envelope and v1/v2 record shapes', async () => {
        const { app, generator } = await buildApp();
        const [v1] = await generator.generate(1);
        await post(app, '/schema-version', { version: 2 });
        const [v2] = await generator.generate(1);

        const response = await request(app).get('/volcanic-reports').set('Authorization', AUTH);
        expect(Object.keys(response.body).sort()).toEqual(['data', 'meta']);
        expect(Object.keys(response.body.meta).sort()).toEqual(['count', 'server_time', 'since']);
        const byId = await listById(app);
        expect(() => VolcanicReportV1Schema.parse(byId.get(v1.report_id))).not.toThrow();
        expect(() => VolcanicReportV2Schema.parse(byId.get(v2.report_id))).not.toThrow();
    });
});

describe('POST /admin/schema-version {mode}', () => {
    it('answers {schema_version, mode, changed_at}', async () => {
        const { app } = await buildApp();
        const response = await post(app, '/schema-version', { mode: 'rename_field' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ schema_version: 2, mode: 'rename_field', changed_at: expect.any(String) });
    });

    it.each<object>([{ mode: 'v3' }, { mode: 'rename_field', version: 2 }, { mode: 'type_change', extra: 1 }])(
        'rejects %j with 400 invalid_body',
        async (body) => {
            const { app } = await buildApp();
            const response = await post(app, '/schema-version', body);
            expect(response.status).toBe(400);
            expect(response.body.error).toBe('invalid_body');
        }
    );

    it('renders every record in the mode active when it was created', async () => {
        const { app, generator } = await buildApp();
        const created: Record<string, string> = {};
        for (const mode of ['v1', 'v2_confidence', 'rename_field', 'type_change', 'missing_required']) {
            await post(app, '/schema-version', { mode });
            created[mode] = (await generator.generate(1))[0].report_id;
        }
        await post(app, '/schema-version', { version: 1 });
        const byId = await listById(app);

        expect(() => VolcanicReportV1Schema.parse(byId.get(created.v1))).not.toThrow();
        expect(() => VolcanicReportV2Schema.parse(byId.get(created.v2_confidence))).not.toThrow();

        const renamed = byId.get(created.rename_field)!;
        expect(renamed).not.toHaveProperty('alert_level');
        expect(renamed.level).toEqual(expect.stringMatching(/^(Normal|Waspada|Siaga|Awas)$/));
        expect(Object.keys(renamed).indexOf('level')).toBe(2);

        const typed = byId.get(created.type_change)!;
        expect(typed.alert_level).toEqual(expect.any(Number));
        expect([0, 1, 2, 3]).toContain(typed.alert_level);

        const missing = byId.get(created.missing_required)!;
        expect(missing).not.toHaveProperty('eruption_count_24h');
        expect(missing.report_id).toBe(created.missing_required);
    });
});

describe('POST /admin/malformed', () => {
    it('corrupts exactly the next n responses, in FIFO order, then answers normally', async () => {
        const { app, generator } = await buildApp();
        await generator.generate(2);
        await post(app, '/malformed', { kind: 'truncated', count: 2 });
        const queued = await post(app, '/malformed', { kind: 'invalid_utf8' });
        expect(queued.body.pending.map((p: { kind: string }) => p.kind)).toEqual([
            'truncated',
            'truncated',
            'invalid_utf8',
        ]);

        const kinds: (string | undefined)[] = [];
        for (let i = 0; i < 4; i++) kinds.push((await rawGet(app)).headers['x-pvmbg-malformed']);
        expect(kinds).toEqual(['truncated', 'truncated', 'invalid_utf8', undefined]);
        const state = await request(app).get('/admin/malformed').set('Authorization', AUTH);
        expect(state.body).toEqual({ pending: [], served: 3 });
    });

    it('truncated: a complete HTTP response whose JSON stops early', async () => {
        const { app, generator } = await buildApp();
        await generator.generate(3);
        await post(app, '/malformed', { kind: 'truncated' });
        const body: Buffer = (await rawGet(app)).body;
        expect(() => JSON.parse(body.toString('utf8'))).toThrow();
        expect(body.toString('utf8').startsWith('{"data":[')).toBe(true);
    });

    it('deep_nesting: valid JSON nested 10000 levels deep', async () => {
        const { app } = await buildApp();
        await post(app, '/malformed', { kind: 'deep_nesting' });
        const text = (await rawGet(app)).body.toString('utf8');
        expect(text.startsWith('{"data":' + '['.repeat(10_000))).toBe(true);
        expect(text.length).toBe(8 + 20_000 + 1);
    });

    it('invalid_utf8: the real envelope with an invalid UTF-8 sequence inside a string', async () => {
        const { app, generator } = await buildApp();
        await generator.generate(1);
        await post(app, '/malformed', { kind: 'invalid_utf8' });
        const body: Buffer = (await rawGet(app)).body;
        expect(isUtf8(body)).toBe(false);
        expect(body.includes(Buffer.from([0xc3, 0x28]))).toBe(true);
    });

    it('oversized: streams a well-formed envelope of the requested size', async () => {
        const { app, generator } = await buildApp();
        await generator.generate(2);
        await post(app, '/malformed', { kind: 'oversized', bytes: 2 * 1024 * 1024 });
        const body: Buffer = (await rawGet(app)).body;
        expect(body.length).toBe(2 * 1024 * 1024);
        const parsed = JSON.parse(body.toString('utf8'));
        expect(parsed.data).toHaveLength(26 + 2);
    });

    it.each<object>([{ kind: 'gzip_bomb' }, { kind: 'truncated', count: 0 }, { kind: 'oversized', bytes: 1e9 }])(
        'rejects %j with 400 invalid_body',
        async (body) => {
            const { app } = await buildApp();
            expect((await post(app, '/malformed', body)).status).toBe(400);
        }
    );

    it('oversized: 32 MiB through a slow client keeps at most a few chunks buffered in the mock', async () => {
        const { app } = await buildApp();
        await post(app, '/malformed', { kind: 'oversized', bytes: 32 * 1024 * 1024 });
        const buffered: number[] = [];
        const server = http.createServer(app);
        server.on('request', (_req, res: http.ServerResponse) => {
            const timer = setInterval(() => buffered.push(res.writableLength), 1);
            res.once('close', () => clearInterval(timer));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address() as AddressInfo;

        let received = 0;
        await new Promise<void>((resolve, reject) => {
            http.get(`http://127.0.0.1:${port}/volcanic-reports`, { headers: { Authorization: AUTH } }, (res) => {
                res.on('data', (chunk: Buffer) => {
                    received += chunk.length;
                    res.pause();
                    setImmediate(() => res.resume());
                });
                res.on('end', () => resolve());
                res.on('error', reject);
            }).on('error', reject);
        });
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));

        expect(received).toBe(32 * 1024 * 1024);
        expect(buffered.length).toBeGreaterThan(0);
        expect(Math.max(...buffered)).toBeLessThanOrEqual(4 * 64 * 1024);
    });
});
