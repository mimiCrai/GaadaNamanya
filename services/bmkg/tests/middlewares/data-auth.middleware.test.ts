import 'reflect-metadata';
import request from 'supertest';
import { BMKG_KEY, BNPB_JWT, buildApp, PVMBG_TOKEN, ROTATED_BMKG_KEY } from '../helpers';

const WRONG_BMKG_KEY = 'bmkg_test01_ffffffffffffffffffffffffffffffff';

describe('DataAuthMiddleware', () => {
    const { app } = buildApp();

    it.each([
        ['no credential', {}, 401, 'missing_credential'],
        ['a malformed key', { 'X-BMKG-Key': 'local-bmkg-api-key' }, 401, 'malformed_credential'],
        ['an unknown key', { 'X-BMKG-Key': WRONG_BMKG_KEY }, 403, 'invalid_credential'],
        ['a PVMBG bearer token', { Authorization: `Bearer ${PVMBG_TOKEN}` }, 403, 'foreign_credential'],
        [
            'a PVMBG token next to a valid BMKG key',
            { 'X-BMKG-Key': BMKG_KEY, Authorization: `Bearer ${PVMBG_TOKEN}` },
            403,
            'foreign_credential',
        ],
        ['a BNPB client JWT', { Authorization: `Bearer ${BNPB_JWT}` }, 403, 'foreign_credential'],
    ])('rejects %s', async (_case, headers, status, error) => {
        const response = await request(app).get('/seismic-events').set(headers);

        expect(response.status).toBe(status);
        expect(response.body).toEqual({
            error,
            message: expect.any(String),
            correlation_id: response.headers['x-correlation-id'],
        });
        if (status === 401) {
            expect(response.headers['www-authenticate']).toContain('X-BMKG-Key');
        }
    });

    it.each([BMKG_KEY, ROTATED_BMKG_KEY])('accepts every key in the rotation list (%s)', async (key) => {
        const response = await request(app).get('/tsunami-warnings').set('X-BMKG-Key', key);

        expect(response.status).toBe(200);
    });

    it('protects both data endpoints', async () => {
        const response = await request(app).get('/tsunami-warnings');

        expect(response.status).toBe(401);
    });
});
