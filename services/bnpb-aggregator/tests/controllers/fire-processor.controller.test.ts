import 'reflect-metadata';
import express from 'express';
import { Container } from 'inversify';
import { InversifyExpressServer } from 'inversify-express-utils';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { TYPES } from '../../src/constants/types';
import { InternalAuthMiddleware } from '../../src/middlewares/internal-auth.middleware';
import { SnapshotTooLargeError } from '../../src/repositories/fire-processor.repository';
import '../../src/controllers/fire-processor.controller';

const pointer = {
    _id: 'snapshot',
    fileId: 'f'.repeat(24),
    feedOffset: 41,
    kafkaOffset: '57',
    sha256: 'a'.repeat(64),
    sizeBytes: 0,
    savedAt: new Date('2026-11-22T00:00:00Z'),
};

describe('Fire processor state endpoints (CP 3.4/3.5)', () => {
    const repository = {
        saveSnapshot: jest.fn(),
        openSnapshot: jest.fn(),
        putStats: jest.fn(),
        getStats: jest.fn(),
        recordLate: jest.fn(),
        countLate: jest.fn(),
        countHazards: jest.fn(),
        countUnprocessed: jest.fn(),
    };
    const container = new Container();
    container.bind(TYPES.IFireProcessorRepository).toConstantValue(repository);
    container.bind(TYPES.InternalAuthMiddleware).to(InternalAuthMiddleware);
    const app = new InversifyExpressServer(container).setConfig((server) => server.use(express.json())).build();
    const key = process.env.BNPB_INTERNAL_API_KEY!;
    const body = gzipSync(Buffer.from(JSON.stringify({ v: 1, last_offset: 41 })));
    beforeEach(() => jest.clearAllMocks());

    it('streams the gzip body to the repository with the feed and Kafka offsets', async () => {
        let received = Buffer.alloc(0);
        repository.saveSnapshot.mockImplementation(async (stream: Readable, meta: unknown) => {
            for await (const chunk of stream) received = Buffer.concat([received, chunk as Buffer]);
            return { stored: true, pointer: { ...pointer, sizeBytes: received.length, meta } };
        });
        const response = await request(app)
            .put('/internal/fire-processor/snapshot')
            .set('X-BNPB-Internal-Key', key)
            .set('Content-Type', 'application/gzip')
            .set('X-Feed-Offset', '41')
            .set('X-Kafka-Offset', '57')
            .send(body);
        expect(response.status).toBe(200);
        expect(received.equals(body)).toBe(true);
        expect(repository.saveSnapshot.mock.calls[0][1]).toEqual({ feedOffset: 41, kafkaOffset: '57' });
        expect(response.body).toMatchObject({ stored: true, feed_offset: 41, kafka_offset: '57', size_bytes: body.length });
    });

    it('answers a stale snapshot with 409, an oversized one with 413, and bad headers with 400', async () => {
        const put = () =>
            request(app)
                .put('/internal/fire-processor/snapshot')
                .set('X-BNPB-Internal-Key', key)
                .set('Content-Type', 'application/gzip')
                .set('X-Feed-Offset', '10')
                .send(body);
        repository.saveSnapshot.mockResolvedValueOnce({ stored: false, current: 41 });
        const stale = await put();
        expect(stale.status).toBe(409);
        expect(stale.body).toMatchObject({ error: { code: 'stale' }, current_feed_offset: 41 });
        repository.saveSnapshot.mockRejectedValueOnce(new SnapshotTooLargeError(10));
        expect((await put()).status).toBe(413);
        const noOffset = await request(app)
            .put('/internal/fire-processor/snapshot')
            .set('X-BNPB-Internal-Key', key)
            .set('Content-Type', 'application/gzip')
            .send(body);
        expect(noOffset.status).toBe(400);
        const json = await request(app)
            .put('/internal/fire-processor/snapshot')
            .set('X-BNPB-Internal-Key', key)
            .set('X-Feed-Offset', '1')
            .send({ a: 1 });
        expect(json.status).toBe(400);
    });

    it('serves the stored snapshot bytes with its offsets, 404 when none', async () => {
        repository.openSnapshot.mockResolvedValueOnce(null);
        expect((await request(app).get('/internal/fire-processor/snapshot').set('X-BNPB-Internal-Key', key)).status).toBe(404);
        repository.openSnapshot.mockResolvedValueOnce({ pointer: { ...pointer, sizeBytes: body.length }, stream: Readable.from([body]) });
        const response = await request(app)
            .get('/internal/fire-processor/snapshot')
            .set('X-BNPB-Internal-Key', key)
            .buffer(true)
            .parse((res, done) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => done(null, Buffer.concat(chunks)));
            });
        expect(response.status).toBe(200);
        expect(response.headers['x-feed-offset']).toBe('41');
        expect(response.headers['x-kafka-offset']).toBe('57');
        expect((response.body as Buffer).equals(body)).toBe(true);
    });

    it('stores stats with the offset guard and late detections idempotently', async () => {
        repository.putStats.mockResolvedValueOnce(false);
        const stats = await request(app)
            .put('/internal/fire-processor/stats')
            .set('X-BNPB-Internal-Key', key)
            .send({ last_offset: 3, stats: { fires: 1 } });
        expect(stats.body).toEqual({ stored: false });
        expect(repository.putStats).toHaveBeenCalledWith(3, { fires: 1 }, null);

        repository.recordLate.mockResolvedValueOnce({ inserted: 1, existing: 0 });
        const item = {
            offset: 7,
            detection_key: 'N20|2026-11-12|243|-2.51230|113.80440',
            kind: 'detection',
            event_time: '2026-11-12T02:43:00Z',
            watermark: '2026-11-12T05:00:00Z',
            received_at: null,
        };
        const late = await request(app).post('/internal/satellite/late-detections').set('X-BNPB-Internal-Key', key).send({ items: [item] });
        expect(late.body).toEqual({ inserted: 1, existing: 0 });
        expect(repository.recordLate.mock.calls[0][0][0]).toMatchObject({ offset: 7, eventTime: new Date(item.event_time), receivedAt: null });
        const invalid = await request(app)
            .post('/internal/satellite/late-detections')
            .set('X-BNPB-Internal-Key', key)
            .send({ items: [{ ...item, kind: 'retract' }] });
        expect(invalid.status).toBe(400);
    });

    it('summarises every counter and reports partial results instead of failing', async () => {
        repository.getStats.mockResolvedValueOnce({
            _id: 'stats',
            lastOffset: 99,
            stats: { fires: 3, single_detections: 4, low_excluded: 2, late_detections: 1 },
            instanceId: 'fp-1',
            updatedAt: new Date('2026-11-22T00:00:00Z'),
        });
        repository.countLate.mockResolvedValueOnce(1);
        repository.countHazards.mockRejectedValueOnce(new Error('shard down'));
        repository.countUnprocessed.mockResolvedValueOnce({ parked: 2 });
        const response = await request(app).get('/internal/satellite/summary').set('X-BNPB-Internal-Key', key);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            processor: {
                fires: 3,
                single_detections: 4,
                low_excluded: 2,
                late_detections: 1,
                last_offset: 99,
                instance_id: 'fp-1',
                updated_at: '2026-11-22T00:00:00.000Z',
            },
            late_detections_stored: 1,
            hazard_events: null,
            unprocessed: { parked: 2 },
            partial: true,
        });
    });
});
