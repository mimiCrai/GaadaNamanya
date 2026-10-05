import 'reflect-metadata';
import { Application } from 'express';
import request from 'supertest';
import { VolcanicReport } from '../../src/types/contract';
import { ADMIN_TOKEN, buildApp, captureLogs, PVMBG_TOKEN } from '../helpers';

describe('AdminController', () => {
    const post = (app: Application, path: string, body: object) =>
        request(app).post(`/admin${path}`).set('X-Admin-Token', ADMIN_TOKEN).send(body);
    const listReports = async (app: Application): Promise<VolcanicReport[]> =>
        (await request(app).get('/volcanic-reports').set('Authorization', `Bearer ${PVMBG_TOKEN}`)).body.data;

    it('exposes only POST /admin/schema-version and POST /admin/outage', async () => {
        const { app } = buildApp();

        for (const path of ['/admin/schema-version', '/admin/outage']) {
            const response = await request(app).get(path).set('X-Admin-Token', ADMIN_TOKEN);
            expect(response.status).toBe(404);
        }
        expect((await post(app, '/delay', { min_ms: 3000, max_ms: 3000 })).status).toBe(404);
    });

    describe('POST /admin/schema-version', () => {
        it('adds confidence_level only to records created while v2 is active', async () => {
            const { app, generator } = buildApp();

            const [v1Report] = generator.generate(1);
            const switched = await post(app, '/schema-version', { version: 2 });
            const [v2Report] = generator.generate(1);
            await post(app, '/schema-version', { version: 1 });
            const [backToV1Report] = generator.generate(1);

            expect(switched.status).toBe(200);
            expect(switched.body).toEqual({ schema_version: 2, changed_at: expect.any(String) });

            // one response mixes both shapes, and the v2 record keeps its field after switching back
            const byId = new Map((await listReports(app)).map((report) => [report.report_id, report]));
            expect(byId.get(v1Report.report_id)).not.toHaveProperty('confidence_level');
            expect(byId.get(v2Report.report_id)!.confidence_level).toEqual(expect.any(Number));
            expect(byId.get(backToV1Report.report_id)).not.toHaveProperty('confidence_level');
        });

        it('keeps changed_at when the active version is posted again', async () => {
            const { app } = buildApp();
            const first = await post(app, '/schema-version', { version: 2 });
            await new Promise((resolve) => setTimeout(resolve, 5));

            const again = await post(app, '/schema-version', { version: 2 });

            expect(again.body).toEqual(first.body);
        });

        it.each<object>([{ version: 3 }, { version: '2' }, {}, { version: 2, extra: true }])(
            'rejects body %j with 400 invalid_body',
            async (body) => {
                const { app } = buildApp();
                const response = await post(app, '/schema-version', body);

                expect(response.status).toBe(400);
                expect(response.body.error).toBe('invalid_body');
            }
        );

        it('rejects malformed JSON with 400 invalid_body', async () => {
            const { app } = buildApp();
            const response = await request(app)
                .post('/admin/schema-version')
                .set('X-Admin-Token', ADMIN_TOKEN)
                .set('Content-Type', 'application/json')
                .send('{"version":');

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('invalid_body');
        });
    });

    describe('POST /admin/outage', () => {
        it('defaults to error mode and keeps /admin working during the outage', async () => {
            const { app } = buildApp();

            const started = await post(app, '/outage', { enabled: true });
            const schemaDuringOutage = await post(app, '/schema-version', { version: 2 });
            const ended = await post(app, '/outage', { enabled: false });

            expect(started.body).toEqual({
                enabled: true,
                mode: 'error',
                since: expect.any(String),
                held_requests: 0,
                released_requests: 0,
            });
            expect(schemaDuringOutage.status).toBe(200);
            expect(ended.body).toEqual(expect.objectContaining({ enabled: false, since: null }));
        });

        it('rejects an unknown mode', async () => {
            const { app } = buildApp();
            const response = await post(app, '/outage', { enabled: true, mode: 'slow' });

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('invalid_body');
        });
    });

    it('logs every schema and outage change at warn level', async () => {
        const logs = captureLogs();
        const { app } = buildApp({ logger: logs.logger });

        await post(app, '/schema-version', { version: 2 });
        await post(app, '/outage', { enabled: true, mode: 'hang' });
        await post(app, '/outage', { enabled: false });

        const warnings = logs.entries().filter((entry) => entry.level === 'warn');
        expect(warnings.map((entry) => entry.msg)).toEqual([
            'PVMBG schema version changed',
            'PVMBG outage started',
            'PVMBG outage ended',
        ]);
        expect(warnings[0]).toEqual(expect.objectContaining({ previous_version: 1, schema_version: 2 }));
        expect(logs.raw()).not.toContain(ADMIN_TOKEN);
    });
});
