import 'reflect-metadata';
import express from 'express';
import { Container } from 'inversify';
import { InversifyExpressServer } from 'inversify-express-utils';
import request from 'supertest';
import { TYPES } from '../../src/constants/types';
import { InternalAuthMiddleware } from '../../src/middlewares/internal-auth.middleware';
import '../../src/controllers/field-report.controller';

const id = '6b0f8c44-1f43-4a54-9d55-2f1a3c9e7b10';
const message = {
    v: 1,
    report: {
        report_id: id,
        hazard_type: 'VOLCANIC',
        latitude: -7.54,
        longitude: 110.44,
        description: 'Awan panas',
        severity_estimate: 'SIAGA',
        reported_at: '2026-11-20T10:00:00+07:00',
    },
    reporter: { sub: 'u-1', role: 'lapangan' },
    accepted_at: '2026-11-20T03:00:01.000Z',
};
const stored = {
    _id: id,
    reportId: id,
    hazardType: 'VOLCANIC',
    latitude: -7.54,
    longitude: 110.44,
    description: 'Awan panas',
    severityEstimate: 'SIAGA',
    reportedAt: new Date('2026-11-20T03:00:00Z'),
    reporter: { sub: 'u-1', role: 'lapangan' },
    acceptedAt: new Date('2026-11-20T03:00:01Z'),
    processedAt: new Date('2026-11-20T03:00:02Z'),
    contentSha256: 'a'.repeat(64),
    kafka: { topic: 'field-reports', partition: 1, offset: '5' },
    correlationId: 'c',
    deliveries: 2,
};

describe('Field report store endpoints (D-39)', () => {
    const reports = { insertOnce: jest.fn(), findById: jest.fn(), list: jest.fn() };
    const container = new Container();
    container.bind(TYPES.IFieldReportRepository).toConstantValue(reports);
    container.bind(TYPES.InternalAuthMiddleware).to(InternalAuthMiddleware);
    const app = new InversifyExpressServer(container).setConfig((server) => server.use(express.json())).build();
    const key = process.env.BNPB_INTERNAL_API_KEY!;
    beforeEach(() => jest.clearAllMocks());

    it('PUT inserts idempotently and reports created / duplicate / conflict', async () => {
        for (const result of ['created', 'duplicate', 'conflict']) {
            reports.insertOnce.mockResolvedValueOnce({ result, report: stored, incomingSha256: 'b'.repeat(64) });
            const response = await request(app)
                .put(`/internal/field-reports/${id}`)
                .set('X-BNPB-Internal-Key', key)
                .send({ message, kafka: { topic: 'field-reports', partition: 1, offset: '5' } });
            expect(response.status).toBe(200);
            expect(response.body.result).toBe(result);
            expect(response.body.report).toEqual(expect.objectContaining({ report_id: id, status: 'processed', deliveries: 2 }));
        }
        expect(reports.insertOnce).toHaveBeenCalledWith(
            message,
            { topic: 'field-reports', partition: 1, offset: '5' },
            expect.any(String)
        );
    });

    it('PUT rejects a body whose report_id differs from the path, and requires the internal key', async () => {
        const other = await request(app)
            .put('/internal/field-reports/00000000-0000-4000-8000-000000000000')
            .set('X-BNPB-Internal-Key', key)
            .send({ message });
        expect(other.status).toBe(400);
        expect((await request(app).put(`/internal/field-reports/${id}`).send({ message })).status).toBe(401);
        expect(reports.insertOnce).not.toHaveBeenCalled();
    });

    it('GET returns processed or 404; list pages by report_id', async () => {
        reports.findById.mockResolvedValueOnce(stored).mockResolvedValueOnce(null);
        const found = await request(app).get(`/internal/field-reports/${id}`).set('X-BNPB-Internal-Key', key);
        expect(found.body.status).toBe('processed');
        expect((await request(app).get(`/internal/field-reports/${id}`).set('X-BNPB-Internal-Key', key)).status).toBe(404);
        reports.list.mockResolvedValueOnce([stored]);
        const page = await request(app).get('/internal/field-reports?limit=1').set('X-BNPB-Internal-Key', key);
        expect(page.body).toEqual({ items: [expect.objectContaining({ report_id: id })], next_after: id });
        expect(reports.list).toHaveBeenCalledWith(undefined, 1);
    });
});
