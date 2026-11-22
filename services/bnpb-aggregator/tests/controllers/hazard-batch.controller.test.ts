import 'reflect-metadata';
import express from 'express';
import { Container } from 'inversify';
import { InversifyExpressServer } from 'inversify-express-utils';
import request from 'supertest';
import { TYPES } from '../../src/constants/types';
import { InternalAuthMiddleware } from '../../src/middlewares/internal-auth.middleware';
import { runLimited } from '../../src/controllers/hazard-batch.controller';

const hazard = {
    hazard_type: 'WILDFIRE',
    severity: 'SIAGA',
    area_name: 'Kalimantan Tengah',
    latitude: -2.51234,
    longitude: 113.8045,
    occurred_at: '2026-11-12T02:43:00Z',
    attributes: { detection_count: 6 },
};

describe('POST /internal/hazards/batch (usulan 3.4)', () => {
    const writes = { apply: jest.fn() };
    const container = new Container();
    container.bind(TYPES.IHazardWriteRepository).toConstantValue(writes);
    container.bind(TYPES.InternalAuthMiddleware).to(InternalAuthMiddleware);
    const app = new InversifyExpressServer(container).setConfig((server) => server.use(express.json())).build();
    const key = process.env.BNPB_INTERNAL_API_KEY!;
    beforeEach(() => jest.clearAllMocks());

    it('maps ops to the repository and reports a result per op plus totals', async () => {
        writes.apply.mockImplementation(async (op: { op: string; sourceRefId: string }) => ({
            op: op.op,
            sourceRefId: op.sourceRefId,
            hazardId: `id-${op.sourceRefId}`,
            result: op.op === 'delete' ? 'applied' : 'unchanged',
            changeType: null,
        }));
        const response = await request(app)
            .post('/internal/hazards/batch')
            .set('X-BNPB-Internal-Key', key)
            .send({
                ops: [
                    { op: 'delete', source: 'SATELIT', source_ref_id: 'fire-a', version: 10 },
                    { op: 'upsert', source: 'SATELIT', source_ref_id: 'fire-b', version: 11, hazard },
                ],
            });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            results: [
                { op: 'delete', source_ref_id: 'fire-a', hazard_id: 'id-fire-a', result: 'applied' },
                { op: 'upsert', source_ref_id: 'fire-b', hazard_id: 'id-fire-b', result: 'unchanged' },
            ],
            applied: 1,
            unchanged: 1,
            skipped: 0,
        });
        expect(writes.apply).toHaveBeenCalledWith(
            expect.objectContaining({
                op: 'upsert',
                sourceRefId: 'fire-b',
                version: 11,
                hazard: expect.objectContaining({ hazardType: 'WILDFIRE', occurredAt: new Date('2026-11-12T02:43:00Z') }),
            }),
            expect.any(String)
        );
    });

    it.each([
        ['another source (leader-only path)', { ops: [{ op: 'delete', source: 'PVMBG', source_ref_id: 'x', version: 1 }] }],
        ['the same fire twice', { ops: [1, 2].map((version) => ({ op: 'delete', source: 'SATELIT', source_ref_id: 'x', version })) }],
        ['a negative version', { ops: [{ op: 'delete', source: 'SATELIT', source_ref_id: 'x', version: -1 }] }],
        ['an unknown hazard field', { ops: [{ op: 'upsert', source: 'SATELIT', source_ref_id: 'x', version: 1, hazard: { ...hazard, extra: 1 } }] }],
        ['an empty batch', { ops: [] }],
        ['more than 500 ops', { ops: Array.from({ length: 501 }, (_, i) => ({ op: 'delete', source: 'SATELIT', source_ref_id: `f${i}`, version: 1 })) }],
    ])('rejects %s with 400', async (_name, body) => {
        const response = await request(app).post('/internal/hazards/batch').set('X-BNPB-Internal-Key', key).send(body);
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('bad_request');
        expect(writes.apply).not.toHaveBeenCalled();
    });

    it('requires the internal key', async () => {
        const response = await request(app).post('/internal/hazards/batch').send({ ops: [] });
        expect(response.status).toBe(401);
    });

    it('runs ops with bounded parallelism and keeps result order', async () => {
        let active = 0;
        let peak = 0;
        const results = await runLimited([5, 1, 4, 2, 3], 2, async (value) => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, value));
            active--;
            return value * 10;
        });
        expect(results).toEqual([50, 10, 40, 20, 30]);
        expect(peak).toBe(2);
    });
});
