import 'reflect-metadata';
import { Application } from 'express';
import request from 'supertest';
import { SeismicEvent, TsunamiWarning, TsunamiWarningSchema } from '../../src/types/contract';
import { BMKG_KEY, buildApp } from '../helpers';

describe('GET /tsunami-warnings', () => {
    let app: Application;
    beforeAll(async () => ({ app } = await buildApp()));
    const get = (path: string, query: Record<string, string> = {}) =>
        request(app).get(path).query(query).set('X-BMKG-Key', BMKG_KEY);

    it('returns contract-valid warnings that reference existing seismic events', async () => {
        const warnings = await get('/tsunami-warnings');
        const events = await get('/seismic-events');

        expect(warnings.status).toBe(200);
        expect(() => TsunamiWarningSchema.array().min(1).parse(warnings.body.data)).not.toThrow();
        const eventIds = new Set(events.body.data.map((event: SeismicEvent) => event.event_id));
        for (const warning of warnings.body.data as TsunamiWarning[]) {
            expect(eventIds.has(warning.related_event_id)).toBe(true);
        }
    });

    it('filters by issued_at >= since', async () => {
        const all: TsunamiWarning[] = (await get('/tsunami-warnings')).body.data;

        const response = await get('/tsunami-warnings', { since: all[1].issued_at });

        expect(response.body.data.map((warning: TsunamiWarning) => warning.warning_id)).toEqual(
            all.slice(1).map((warning) => warning.warning_id)
        );
    });
});
