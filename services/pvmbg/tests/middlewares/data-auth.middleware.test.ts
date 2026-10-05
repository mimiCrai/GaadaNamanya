import 'reflect-metadata';
import request from 'supertest';
import { ADMIN_TOKEN, BMKG_KEY, BNPB_JWT, buildApp, PVMBG_TOKEN, ROTATED_PVMBG_TOKEN } from '../helpers';

const WRONG_PVMBG_TOKEN = 'pvmbg.bnpb.ffffffffffffffffffffffffffffffff';

describe('DataAuthMiddleware', () => {
    const { app } = buildApp();

    it.each([
        ['no credential', {}, 401, 'missing_credential'],
        ['a non-bearer Authorization header', { Authorization: `Basic ${PVMBG_TOKEN}` }, 401, 'missing_credential'],
        ['the admin token', { 'X-Admin-Token': ADMIN_TOKEN }, 401, 'missing_credential'],
        ['the admin token as bearer', { Authorization: `Bearer ${ADMIN_TOKEN}` }, 401, 'malformed_credential'],
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
    ])('rejects %s', async (_case, headers, status, error) => {
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
