import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Application } from 'express';
import request from 'supertest';
import { SEED_REPORT_COUNT } from '../../src/services/generator.service';
import { ALERT_LEVELS, VolcanicReport, VolcanicReportV1Schema } from '../../src/types/contract';
import { buildApp, PVMBG_TOKEN } from '../helpers';

describe('GET /volcanic-reports', () => {
    let app: Application;
    beforeAll(async () => ({ app } = await buildApp()));
    const get = (query: Record<string, string> = {}) =>
        request(app).get('/volcanic-reports').query(query).set('Authorization', `Bearer ${PVMBG_TOKEN}`);

    it('answers an aggregator poll with contract-valid reports in a { data, meta } envelope', async () => {
        const correlationId = randomUUID();
        const since = new Date(Date.now() - 25 * 3600_000).toISOString();

        const response = await get({ since }).set('X-Correlation-ID', correlationId);

        expect(response.status).toBe(200);
        expect(response.headers['x-correlation-id']).toBe(correlationId);
        expect(response.body.meta).toEqual({ count: SEED_REPORT_COUNT, since, server_time: expect.any(String) });
        expect(() => VolcanicReportV1Schema.array().length(SEED_REPORT_COUNT).parse(response.body.data)).not.toThrow();
    });

    it('seeds schema v1 only (no confidence_level key) and covers all four alert levels', async () => {
        const reports: VolcanicReport[] = (await get()).body.data;

        expect(reports.every((report) => !('confidence_level' in report))).toBe(true);
        expect(new Set(reports.map((report) => report.alert_level))).toEqual(new Set(ALERT_LEVELS));
    });

    it('returns only reports with reported_at >= since, oldest first', async () => {
        const all: VolcanicReport[] = (await get()).body.data;

        const response = await get({ since: all[10].reported_at });

        expect(response.body.data.map((report: VolcanicReport) => report.report_id)).toEqual(
            all.slice(10).map((report) => report.report_id)
        );
    });

    it.each<Record<string, string>>([{ since: 'yesterday' }, { limit: '0' }, { limit: 'abc' }])(
        'returns 400 for invalid query %j',
        async (query) => {
            const response = await get(query);

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('invalid_query');
        }
    );
});
