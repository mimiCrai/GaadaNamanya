import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Application } from 'express';
import request from 'supertest';
import { SEED_EVENT_COUNT } from '../../src/services/generator.service';
import { SeismicEvent, SeismicEventSchema } from '../../src/types/contract';
import { BMKG_KEY, buildApp } from '../helpers';

describe('GET /seismic-events', () => {
    let app: Application;
    beforeAll(async () => ({ app } = await buildApp()));
    const get = (query: Record<string, string> = {}) =>
        request(app).get('/seismic-events').query(query).set('X-BMKG-Key', BMKG_KEY);

    it('answers an aggregator poll with contract-valid events in a { data, meta } envelope', async () => {
        const correlationId = randomUUID();
        const since = new Date(Date.now() - 25 * 3600_000).toISOString();

        const response = await get({ since }).set('X-Correlation-ID', correlationId);

        expect(response.status).toBe(200);
        expect(response.headers['x-correlation-id']).toBe(correlationId);
        expect(response.body.meta).toEqual({ count: SEED_EVENT_COUNT, since, server_time: expect.any(String) });
        expect(() => SeismicEventSchema.array().length(SEED_EVENT_COUNT).parse(response.body.data)).not.toThrow();
    });

    it('returns only events with occurred_at >= since, oldest first', async () => {
        const all: SeismicEvent[] = (await get()).body.data;

        const response = await get({ since: all[10].occurred_at });

        expect(response.body.data.map((event: SeismicEvent) => event.event_id)).toEqual(
            all.slice(10).map((event) => event.event_id)
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
