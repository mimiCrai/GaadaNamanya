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

    it('pages through 1,001 reports sharing one reported_at with the (since, after_id) cursor', async () => {
        const { app: paged, reports } = await buildApp();
        const at = '2026-11-20T10:00:00.000Z';
        await reports.insert(
            Array.from({ length: 1001 }, (_, index) => ({
                report_id: `tie-${String(index).padStart(4, '0')}`,
                volcano_id: 'merapi',
                alert_level: 'Waspada' as const,
                eruption_count_24h: 1,
                ash_column_height_m: 100,
                reported_at: at,
            }))
        );
        const page = (query: Record<string, string>) =>
            request(paged).get('/volcanic-reports').query(query).set('Authorization', `Bearer ${PVMBG_TOKEN}`);

        const first = (await page({ since: at, limit: '1000' })).body.data as VolcanicReport[];
        expect(first).toHaveLength(1000);
        const last = first[first.length - 1];
        const second = (await page({ since: last.reported_at, after_id: last.report_id, limit: '1000' })).body
            .data as VolcanicReport[];
        // after the tie the page continues with the seeded (later) reports, never repeating a tie
        const ids = second.map((report) => report.report_id);
        expect(ids[0]).toBe('tie-1000');
        expect(ids.filter((id) => id.startsWith('tie-'))).toEqual(['tie-1000']);
        expect(second.slice(1).every((report) => report.reported_at > at)).toBe(true);
        expect(new Set([...first, ...second.slice(0, 1)].map((report) => report.report_id)).size).toBe(1001);
    });

    it.each<Record<string, string>>([{ since: 'yesterday' }, { limit: '0' }, { limit: 'abc' }, { after_id: 'r-1' }])(
        'returns 400 for invalid query %j',
        async (query) => {
            const response = await get(query);

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('invalid_query');
        }
    );
});
