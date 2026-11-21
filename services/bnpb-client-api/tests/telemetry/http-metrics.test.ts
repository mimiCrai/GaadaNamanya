import express from 'express';
import request from 'supertest';
import { Registry } from 'prom-client';
import { installHttpMetrics } from '../../src/telemetry/metrics';

describe('HTTP metrics', () => {
    it('uses route templates, counts role-specific 503s, and excludes probes and scrapes', async () => {
        const app = express();
        const registry = new Registry();
        installHttpMetrics(app, registry);
        app.get('/hazards/:hazardId', (_req, res) => {
            res.locals.authRole = 'lapangan';
            res.json({ ok: true });
        });
        app.get('/overloaded', (_req, res) => {
            res.locals.authRole = 'public';
            res.status(503).end();
        });
        app.get('/health/live', (_req, res) => res.end());
        await request(app).get('/hazards/unique-id-one?token=never-a-label').expect(200);
        await request(app).get('/hazards/unique-id-two').expect(200);
        await request(app).get('/random-path-one').expect(404);
        await request(app).get('/random-path-two').expect(404);
        await request(app).get('/overloaded').expect(503);
        await request(app).get('/health/live').expect(200);
        const response = await request(app).get('/metrics').expect(200);
        expect(response.text).toContain('route="/hazards/:hazardId",status_code="200",role="lapangan"} 2');
        expect(response.text).toContain('route="unmatched",status_code="404",role="anonymous"} 2');
        expect(response.text).toContain('route="/overloaded",status_code="503",role="public"} 1');
        expect(response.text).toContain('bnpb_http_requests_active 0');
        expect(response.text).not.toMatch(/unique-id|random-path|never-a-label|route="\/health|route="\/metrics/);
    });

    it('reuses a supplied registry without duplicate metric or endpoint registration', async () => {
        const registry = new Registry();
        const first = express();
        const second = express();
        installHttpMetrics(first, registry, false);
        installHttpMetrics(second, registry);
        first.get('/ok', (_req, res) => res.end());
        await request(first).get('/ok').expect(200);
        await request(first).get('/metrics').expect(404);
        const response = await request(second).get('/metrics').expect(200);
        expect(response.text).toContain('route="/ok",status_code="200",role="anonymous"} 1');
    });
});
