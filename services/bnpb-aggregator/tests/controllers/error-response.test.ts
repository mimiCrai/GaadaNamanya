import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import { createApp, createContainer } from '../../src/app';
import { TYPES } from '../../src/constants/types';
import { logger } from '../../src/libs/logger';
import { ReadApiError } from '../../src/types/canonical-read';

const correlationId = '11111111-1111-4111-8111-111111111111';

describe('Aggregator HTTP error responses', () => {
    const query = { hazards: jest.fn(), events: jest.fn() };
    let app: express.Application;

    beforeAll(async () => {
        const container = await createContainer();
        container.rebind(TYPES.ICanonicalQueryService).toConstantValue(query);
        app = await createApp(container);
    });

    beforeEach(() => jest.clearAllMocks());

    it.each(['/internal/hazards', '/internal/audit/events'])(
        'hides unexpected error messages, codes, and details on %s while retaining the internal log',
        async (path) => {
            const error = Object.assign(new Error('secret database URI on canonical-shard-b'), {
                code: 'private_driver_error',
                errors: [{ host: 'private-host' }],
            });
            query.hazards.mockRejectedValue(error);
            query.events.mockRejectedValue(error);
            const log = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
            try {
                const response = await request(app)
                    .get(path)
                    .set('X-BNPB-Internal-Key', process.env.BNPB_INTERNAL_API_KEY!)
                    .set('Authorization', `Bearer ${process.env.BNPB_AUDIT_TOKEN}`)
                    .set('X-Correlation-ID', correlationId);

                expect(response.status).toBe(500);
                expect(response.body).toEqual({
                    error: {
                        ...(path.includes('/audit/') ? { code: 'internal_error' } : {}),
                        message: 'Internal Server Error',
                    },
                });
                expect(log).toHaveBeenCalledWith(
                    expect.objectContaining({ err: error, correlationId }),
                    'Request error'
                );
            } finally {
                log.mockRestore();
            }
        }
    );

    it.each([
        [502, 'Bad Gateway', 'internal_error'],
        [503, 'Service Unavailable', 'unavailable'],
        [504, 'Gateway Timeout', 'internal_error'],
    ])('retains status %i with a generic message and a safe audit error code', async (status, message, code) => {
        query.events.mockRejectedValue(
            Object.assign(new Error('sensitive infrastructure details'), {
                status,
                code: 'private_driver_error',
                errors: [{ detail: 'secret' }],
            })
        );

        const response = await request(app)
            .get('/internal/audit/events')
            .set('Authorization', `Bearer ${process.env.BNPB_AUDIT_TOKEN}`);

        expect(response.status).toBe(status);
        expect(response.body).toEqual({ error: { code, message } });
    });

    it('retains the audit contract for a bad cursor', async () => {
        query.events.mockRejectedValue(new ReadApiError('bad_request', 'Invalid cursor'));

        const response = await request(app)
            .get('/internal/audit/events')
            .set('Authorization', `Bearer ${process.env.BNPB_AUDIT_TOKEN}`);

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ error: { code: 'bad_request', message: 'Invalid cursor' } });
    });
});
