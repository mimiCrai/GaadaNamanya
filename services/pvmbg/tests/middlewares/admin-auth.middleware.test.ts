import 'reflect-metadata';
import request from 'supertest';
import { TYPES } from '../../src/constants/types';
import { OutageService } from '../../src/services/outage.service';
import { SchemaService } from '../../src/services/schema.service';
import { ADMIN_TOKEN, BMKG_KEY, buildApp, PVMBG_TOKEN } from '../helpers';

const ADMIN_CALLS: [string, object][] = [
    ['/admin/schema-version', { version: 2 }],
    ['/admin/outage', { enabled: true }],
];

describe('AdminAuthMiddleware', () => {
    it.each([
        ['no credential', {}, 401, 'missing_credential'],
        ['a wrong admin token', { 'X-Admin-Token': `${ADMIN_TOKEN}x` }, 403, 'invalid_credential'],
        ['a valid PVMBG data token', { Authorization: `Bearer ${PVMBG_TOKEN}` }, 403, 'foreign_credential'],
        ['a BMKG key', { 'X-BMKG-Key': BMKG_KEY }, 403, 'foreign_credential'],
    ])('rejects %s on every admin endpoint without changing state', async (_case, headers, status, error) => {
        const { app, container } = buildApp();

        for (const [path, body] of ADMIN_CALLS) {
            const response = await request(app).post(path).set(headers).send(body);

            expect(response.status).toBe(status);
            expect(response.body.error).toBe(error);
        }
        expect(container.get<SchemaService>(TYPES.SchemaService).version).toBe(1);
        expect(container.get<OutageService>(TYPES.OutageService).active).toBeUndefined();
    });
});
