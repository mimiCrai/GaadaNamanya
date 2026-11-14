import 'reflect-metadata';
import { Container } from 'inversify';
import { InversifyExpressServer } from 'inversify-express-utils';
import request from 'supertest';
import { Binary } from 'mongodb';
import { TYPES } from '../../src/constants/types';
import { AuditAuthMiddleware } from '../../src/middlewares/audit-auth.middleware';
import { InternalAuthMiddleware } from '../../src/middlewares/internal-auth.middleware';
import '../../src/controllers/audit-unprocessed.controller';
import '../../src/controllers/dlq.controller';
import '../../src/controllers/metrics.controller';
import { parseFailuresTotal } from '../../src/libs/metrics';

const query = { audit: jest.fn(), list: jest.fn(), detail: jest.fn(), entry: jest.fn() };
const payloads = { openSink: jest.fn(), openDownload: jest.fn(), readAll: jest.fn(), delete: jest.fn() };

describe('Unprocessed message endpoints', () => {
    const container = new Container();
    container.bind(TYPES.IUnprocessedQueryService).toConstantValue(query);
    container.bind(TYPES.IPayloadStore).toConstantValue(payloads);
    container.bind(TYPES.AuditAuthMiddleware).to(AuditAuthMiddleware);
    container.bind(TYPES.InternalAuthMiddleware).to(InternalAuthMiddleware);
    const app = new InversifyExpressServer(container).build();
    const audit = `Bearer ${process.env.BNPB_AUDIT_TOKEN}`;
    const internalKey = process.env.BNPB_INTERNAL_API_KEY!;
    beforeEach(() => jest.clearAllMocks());

    describe('GET /internal/audit/unprocessed', () => {
        it.each([undefined, 'Bearer wrong', `Bearer ${internalKey}`])('requires the audit token (%s)', async (auth) => {
            const call = request(app).get('/internal/audit/unprocessed');
            if (auth) call.set('Authorization', auth);
            const result = await call;
            expect(result.status).toBe(401);
            expect(result.body).toEqual({ error: { code: 'unauthorized', message: 'Invalid or missing audit token' } });
            expect(query.audit).not.toHaveBeenCalled();
        });

        it('passes source, limit and cursor; omitted limit is left to the service default (100)', async () => {
            const body = { items: [], next_cursor: null, partial: false, unavailable_units: [] };
            query.audit.mockResolvedValue(body);
            const result = await request(app).get('/internal/audit/unprocessed').set('Authorization', audit);
            expect(result.status).toBe(200);
            expect(result.body).toEqual(body);
            expect(query.audit).toHaveBeenCalledWith({});
            await request(app)
                .get('/internal/audit/unprocessed?source=PVMBG&limit=1000&cursor=abc')
                .set('Authorization', audit);
            expect(query.audit).toHaveBeenLastCalledWith({ source: 'PVMBG', limit: 1000, cursor: 'abc' });
        });

        it.each([{ limit: 0 }, { limit: 1001 }, { limit: 'x' }, { source: 'BPBD' }])(
            'rejects %j with the standard body',
            async (params) => {
                const result = await request(app)
                    .get('/internal/audit/unprocessed')
                    .query(params)
                    .set('Authorization', audit);
                expect(result.status).toBe(400);
                expect(result.body).toEqual({
                    error: { code: 'bad_request', message: 'Invalid source, limit, or cursor' },
                });
            }
        );
    });

    describe('GET /internal/dlq', () => {
        it('requires the internal service key (end users never hold it)', async () => {
            expect((await request(app).get('/internal/dlq')).status).toBe(401);
            expect((await request(app).get('/internal/dlq').set('X-BNPB-Internal-Key', 'x'.repeat(32))).status).toBe(
                403
            );
            expect((await request(app).get('/internal/dlq').set('Authorization', audit)).status).toBe(401);
        });

        it('lists and returns details, 404 for unknown ids', async () => {
            query.list.mockResolvedValue({ items: [], next_cursor: null, partial: false, unavailable_units: [] });
            const list = await request(app)
                .get('/internal/dlq?status=recovered')
                .set('X-BNPB-Internal-Key', internalKey);
            expect(list.status).toBe(200);
            expect(query.list).toHaveBeenCalledWith({ status: 'recovered' });

            query.detail.mockResolvedValue(null);
            const missing = await request(app)
                .get('/internal/dlq/msg-000000000000000000000000')
                .set('X-BNPB-Internal-Key', internalKey);
            expect(missing.status).toBe(404);
            expect(
                (await request(app).get('/internal/dlq/not-an-id').set('X-BNPB-Internal-Key', internalKey)).status
            ).toBe(404);
        });

        it('streams the exact original bytes', async () => {
            const bytes = Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
            query.entry.mockResolvedValue({
                messageId: 'msg-000000000000000000000001',
                payload: new Binary(bytes),
                payloadRef: null,
                sizeBytes: bytes.length,
                sha256: 'f'.repeat(64),
                contentType: 'application/json',
            });
            const result = await request(app)
                .get('/internal/dlq/msg-000000000000000000000001/raw')
                .set('X-BNPB-Internal-Key', internalKey)
                .buffer(true)
                .parse((res, done) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => done(null, Buffer.concat(chunks)));
                });
            expect(result.status).toBe(200);
            expect(Buffer.compare(result.body as Buffer, bytes)).toBe(0);
            expect(result.headers['x-payload-sha256']).toBe('f'.repeat(64));
        });
    });

    it('exposes Prometheus metrics', async () => {
        parseFailuresTotal.inc({ source: 'PVMBG', reason: 'malformed_json' });
        const result = await request(app).get('/metrics');
        expect(result.status).toBe(200);
        expect(result.text).toContain('bnpb_aggregator_parse_failures_total{source="PVMBG",reason="malformed_json"} 1');
        expect(result.text).toContain('bnpb_aggregator_unprocessed_messages');
        expect(result.text).toContain('bnpb_aggregator_unprocessed_retry_total');
    });
});
