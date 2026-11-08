import 'reflect-metadata';
import { Container } from 'inversify';
import { InversifyExpressServer } from 'inversify-express-utils';
import request from 'supertest';
import { TYPES } from '../../src/constants/types';
import { AuditAuthMiddleware } from '../../src/middlewares/audit-auth.middleware';
import '../../src/controllers/audit.controller';

const query = { events: jest.fn(), checksum: jest.fn(), location: jest.fn() };

describe('AuditController', () => {
    const container = new Container();
    container.bind(TYPES.ICanonicalQueryService).toConstantValue(query);
    container.bind(TYPES.AuditAuthMiddleware).to(AuditAuthMiddleware);
    const app = new InversifyExpressServer(container).build();
    const token = `Bearer ${process.env.BNPB_AUDIT_TOKEN}`;
    beforeEach(() => jest.clearAllMocks());

    it.each([undefined, 'Bearer wrong', `Bearer ${process.env.BNPB_INTERNAL_API_KEY}`, 'Basic abc'])(
        'rejects missing/foreign credentials: %s',
        async (auth) => {
            const call = request(app).get('/internal/audit/events');
            if (auth) call.set('Authorization', auth);
            const result = await call;
            expect(result.status).toBe(401);
            expect(result.body.error.code).toBe('unauthorized');
            expect(query.events).not.toHaveBeenCalled();
        }
    );

    it('passes source, since, limit, and cursor to the query service', async () => {
        const body = { items: [], next_cursor: null, partial: false, unavailable_units: [] };
        query.events.mockResolvedValue(body);
        const result = await request(app)
            .get('/internal/audit/events')
            .query({ source: 'SATELIT', since: '2026-01-01T00:00:00Z', limit: 50, cursor: 'opaque' })
            .set('Authorization', token);
        expect(result.status).toBe(200);
        expect(result.body).toEqual(body);
        expect(query.events).toHaveBeenCalledWith({
            source: 'SATELIT',
            since: '2026-01-01T00:00:00Z',
            limit: 50,
            cursor: 'opaque',
        });
    });

    it.each([{ limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { source: 'OTHER' }, { since: 'invalid' }])(
        'rejects invalid query %j',
        async (params) => {
            const result = await request(app).get('/internal/audit/events').query(params).set('Authorization', token);
            expect(result.status).toBe(400);
            expect(result.body.error.code).toBe('bad_request');
        }
    );

    it('returns a checksum for the requested source', async () => {
        query.checksum.mockResolvedValue({ count: 0, partial: false });
        const result = await request(app)
            .get('/internal/audit/checksum?source=SENSOR_PANTAI')
            .set('Authorization', token);
        expect(result.status).toBe(200);
        expect(query.checksum).toHaveBeenCalledWith('SENSOR_PANTAI');
    });

    it('requires hazard_id and returns 404 only when absence is known', async () => {
        expect((await request(app).get('/internal/audit/location').set('Authorization', token)).status).toBe(400);
        query.location.mockResolvedValue(null);
        const missing = await request(app).get('/internal/audit/location?hazard_id=absent').set('Authorization', token);
        expect(missing.status).toBe(404);
        expect(missing.body.error.code).toBe('not_found');
    });

    it('keeps an incomplete location lookup as a 200 partial result', async () => {
        const body = { hazard_id: 'unknown', locations: [], partial: true, unavailable_units: ['shard-b'] };
        query.location.mockResolvedValue(body);
        const result = await request(app).get('/internal/audit/location?hazard_id=unknown').set('Authorization', token);
        expect(result.status).toBe(200);
        expect(result.body).toEqual(body);
    });
});
