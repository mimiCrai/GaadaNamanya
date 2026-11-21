import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import { createApp, createContainer } from '../../src/app';
import { TYPES } from '../../src/constants/types';
import {
    metricsRegistry,
    parseFailuresTotal,
    satelliteReconnectsTotal,
    setUnprocessedCounter,
} from '../../src/libs/metrics';
import { metricsRegistry as httpRegistry } from '../../src/telemetry/metrics';

/** Full app: OpenAPI validator + global error handler in front of the new routes. */
describe('Unprocessed routes through the full app', () => {
    const query = { audit: jest.fn(), list: jest.fn(), detail: jest.fn(), entry: jest.fn() };
    let app: express.Application;
    const audit = `Bearer ${process.env.BNPB_AUDIT_TOKEN}`;

    beforeAll(async () => {
        const container = await createContainer();
        container.rebind(TYPES.IUnprocessedQueryService).toConstantValue(query);
        app = await createApp(container);
    });

    it('serves /internal/audit/unprocessed', async () => {
        const body = { items: [], next_cursor: null, partial: false, unavailable_units: [] };
        query.audit.mockResolvedValue(body);
        const result = await request(app)
            .get('/internal/audit/unprocessed?source=PVMBG&limit=1000')
            .set('Authorization', audit);
        expect(result.status).toBe(200);
        expect(result.body).toEqual(body);
    });

    it('answers out-of-range limits and bad cursors with the standard audit error body', async () => {
        const result = await request(app).get('/internal/audit/unprocessed?limit=1001').set('Authorization', audit);
        expect(result.status).toBe(400);
        expect(result.body.error.code).toBe('bad_request');
        expect(typeof result.body.error.message).toBe('string');

        const { ReadApiError } = jest.requireActual('../../src/types/canonical-read');
        query.audit.mockRejectedValue(new ReadApiError('bad_request', 'Invalid cursor'));
        const cursor = await request(app).get('/internal/audit/unprocessed?cursor=forged').set('Authorization', audit);
        expect(cursor.status).toBe(400);
        expect(cursor.body).toEqual({ error: { code: 'bad_request', message: 'Invalid cursor' } });
    });

    it('answers storage outages on the audit route with 503 unavailable, not 500', async () => {
        const { ReadApiError } = jest.requireActual('../../src/types/canonical-read');
        query.audit.mockRejectedValue(new ReadApiError('unavailable', 'x', 503));
        const result = await request(app).get('/internal/audit/unprocessed').set('Authorization', audit);
        expect(result.status).toBe(503);
        expect(result.body.error.code).toBe('unavailable');
    });

    it('routes /internal/dlq and /metrics', async () => {
        query.list.mockResolvedValue({ items: [], next_cursor: null, partial: false, unavailable_units: [] });
        const list = await request(app)
            .get('/internal/dlq')
            .set('X-BNPB-Internal-Key', process.env.BNPB_INTERNAL_API_KEY!);
        expect(list.status).toBe(200);
        const metrics = await request(app).get('/metrics');
        expect(metrics.status).toBe(200);
        expect(metrics.headers['content-type']).toContain('text/plain');
    });

    it('exports HTTP, DLQ and satellite metrics through the same endpoint and registry', async () => {
        expect(metricsRegistry).toBe(httpRegistry);
        setUnprocessedCounter(async () => [{ source: 'PVMBG', status: 'parked', count: 2 }]);
        parseFailuresTotal.inc({ source: 'PVMBG', reason: 'schema_incompatible' });
        satelliteReconnectsTotal.inc({ reason: 'manual' });
        try {
            const result = await request(app).get('/metrics').expect(200);
            expect(result.text).toContain('bnpb_http_requests_total');
            expect(result.text).toContain('bnpb_aggregator_parse_failures_total');
            expect(result.text).toContain(
                'bnpb_aggregator_unprocessed_messages{source="PVMBG",status="parked",service="bnpb-aggregator"} 2'
            );
            expect(result.text).toContain('bnpb_aggregator_satellite_reconnects_total');
            expect(result.text.match(/# HELP bnpb_http_requests_total /g)).toHaveLength(1);
        } finally {
            setUnprocessedCounter(async () => []);
        }
    });
});
