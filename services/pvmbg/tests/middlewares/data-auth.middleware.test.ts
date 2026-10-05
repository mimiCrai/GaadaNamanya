import 'reflect-metadata';
import request from 'supertest';
import { TYPES } from '../../src/constants/types';
import { OutageService } from '../../src/services/outage.service';
import { SchemaService } from '../../src/services/schema.service';
import { BMKG_KEY, BNPB_JWT, buildApp, PVMBG_TOKEN, ROTATED_PVMBG_TOKEN } from '../helpers';

const WRONG_PVMBG_TOKEN = 'pvmbg.bnpb.ffffffffffffffffffffffffffffffff';

const REJECTED: [string, Record<string, string>, number, string][] = [
    ['no credential', {}, 401, 'missing_credential'],
    ['a non-bearer Authorization header', { Authorization: `Basic ${PVMBG_TOKEN}` }, 401, 'missing_credential'],
    ['a malformed token', { Authorization: 'Bearer local-pvmbg-token' }, 401, 'malformed_credential'],
    ['an unknown token', { Authorization: `Bearer ${WRONG_PVMBG_TOKEN}` }, 403, 'invalid_credential'],
    ['a BMKG key', { 'X-BMKG-Key': BMKG_KEY }, 403, 'foreign_credential'],
    [
        'a BMKG key next to a valid PVMBG token',
        { 'X-BMKG-Key': BMKG_KEY, Authorization: `Bearer ${PVMBG_TOKEN}` },
        403,
        'foreign_credential',
    ],
    ['a BNPB client JWT', { Authorization: `Bearer ${BNPB_JWT}` }, 403, 'foreign_credential'],
];

describe('DataAuthMiddleware', () => {
    describe('on GET /volcanic-reports', () => {
        const { app } = buildApp();

        it.each(REJECTED)('rejects %s', async (_case, headers, status, error) => {
            const response = await request(app).get('/volcanic-reports').set(headers);

            expect(response.status).toBe(status);
            expect(response.body).toEqual({
                error,
                message: expect.any(String),
                correlation_id: response.headers['x-correlation-id'],
            });
            if (status === 401) {
                expect(response.headers['www-authenticate']).toBe('Bearer realm="pvmbg"');
            }
        });

        it.each([PVMBG_TOKEN, ROTATED_PVMBG_TOKEN])('accepts every token in the rotation list (%s)', async (token) => {
            const response = await request(app).get('/volcanic-reports').set('Authorization', `Bearer ${token}`);

            expect(response.status).toBe(200);
        });
    });

    // /admin/* shares the client token with the data endpoint
    describe('on POST /admin/*', () => {
        it.each(REJECTED)('rejects %s without changing state', async (_case, headers, status, error) => {
            const { app, container } = buildApp();

            for (const [path, body] of [
                ['/admin/schema-version', { version: 2 }],
                ['/admin/outage', { enabled: true }],
            ] as const) {
                const response = await request(app).post(path).set(headers).send(body);

                expect(response.status).toBe(status);
                expect(response.body.error).toBe(error);
            }
            expect(container.get<SchemaService>(TYPES.SchemaService).version).toBe(1);
            expect(container.get<OutageService>(TYPES.OutageService).active).toBeUndefined();
        });

        it.each([PVMBG_TOKEN, ROTATED_PVMBG_TOKEN])('accepts every client token (%s)', async (token) => {
            const { app } = buildApp();
            const response = await request(app)
                .post('/admin/schema-version')
                .set('Authorization', `Bearer ${token}`)
                .send({ version: 2 });

            expect(response.status).toBe(200);
        });
    });
});
