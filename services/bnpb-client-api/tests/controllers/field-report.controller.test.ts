import 'reflect-metadata';
import express from 'express';
import { Container } from 'inversify';
import request from 'supertest';
import { createApp } from '../../src/app';
import { bindings } from '../../src/config/inversify.config';
import { TYPES } from '../../src/constants/types';
import { ApiError } from '../../src/errors/api-error';
import { FieldReportPublisher, PublishUnavailableError } from '../../src/services/field-report-publisher.service';

const report = {
    report_id: '6b0f8c44-1f43-4a54-9d55-2f1a3c9e7b10',
    hazard_type: 'VOLCANIC',
    latitude: -7.5407,
    longitude: 110.4457,
    description: 'Awan panas guguran terlihat dari Pos Babadan',
    severity_estimate: 'SIAGA',
    reported_at: '2026-11-20T10:00:00+07:00',
};
const FORBIDDEN = {
    error: {
        code: 'forbidden',
        message: 'Hanya Tim Lapangan dan BNPB Internal Ops yang boleh mengirim atau melihat laporan lapangan',
    },
};

describe('POST /field-reports (P3 #6, D-38)', () => {
    const jwtAuthenticator = { authenticate: jest.fn() };
    const publisher = { start: jest.fn(), stop: jest.fn(), isReady: jest.fn(() => true), publish: jest.fn() };
    const gateway = { find: jest.fn() };
    let app: express.Application;

    beforeAll(async () => {
        const container = new Container();
        await container.loadAsync(bindings);
        container.rebind(TYPES.JwtAuthenticator).toConstantValue(jwtAuthenticator);
        container.rebind(TYPES.FieldReportPublisher).toConstantValue(publisher);
        container.rebind(TYPES.FieldReportGateway).toConstantValue(gateway);
        app = await createApp(container);
    });
    beforeEach(() => {
        jest.clearAllMocks();
        publisher.isReady.mockReturnValue(true);
        publisher.publish.mockResolvedValue({ partition: 1, offset: '41' });
    });
    const as = (role: string) => jwtAuthenticator.authenticate.mockResolvedValue({ sub: `user-${role}`, sid: 's', role });
    const post = (body: unknown) => request(app).post('/field-reports').set('Authorization', 'Bearer t').send(body as object);

    it.each(['lapangan', 'internal'])('accepts a report from %s with 202 only after the publish resolved', async (role) => {
        as(role);
        let resolvePublish: (value: unknown) => void = () => undefined;
        publisher.publish.mockReturnValue(new Promise((resolve) => (resolvePublish = resolve)));
        const pending = post(report).then((r) => r);
        for (let i = 0; i < 300 && publisher.publish.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
        expect(publisher.publish).toHaveBeenCalledTimes(1);
        resolvePublish({ partition: 0, offset: '7' });
        const response = await pending;

        expect(response.status).toBe(202);
        expect(response.body).toEqual({ report_id: report.report_id, status: 'accepted', accepted_at: expect.any(String) });
        expect(response.headers.location).toBe(`/field-reports/${report.report_id}`);
        const [message] = publisher.publish.mock.calls[0];
        expect(message).toEqual({ v: 1, report, reporter: { sub: `user-${role}`, role }, accepted_at: response.body.accepted_at });
    });

    it('answers public (Media) with 403 and the standard body, without reading or publishing', async () => {
        as('public');
        const response = await post(report);
        expect(response.status).toBe(403);
        expect(response.body).toEqual(FORBIDDEN);
        expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('checks auth before size: an oversized body from public is 403, from lapangan 413', async () => {
        const huge = { ...report, description: 'x'.repeat(20_000) };
        as('public');
        expect((await post(huge)).status).toBe(403);
        as('lapangan');
        const tooLarge = await post(huge);
        expect(tooLarge.status).toBe(413);
        expect(tooLarge.body.error.code).toBe('payload_too_large');
        expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('rejects missing tokens with 401', async () => {
        jwtAuthenticator.authenticate.mockRejectedValue(new ApiError('Missing or invalid Authorization header', 401));
        expect((await post(report)).status).toBe(401);
    });

    it.each([
        { ...report, report_id: 'not-a-uuid' },
        { ...report, latitude: 91 },
        { ...report, reporter: 'someone-else' },
        { ...report, hazard_type: 'TSUNAMI' },
    ])('rejects an invalid body with 400 invalid_body (%#)', async (body) => {
        as('lapangan');
        const response = await post(body);
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('invalid_body');
        expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('answers 503 + Retry-After when Kafka is unreachable within the timeout (never 202)', async () => {
        as('lapangan');
        publisher.publish.mockRejectedValue(new PublishUnavailableError('timeout'));
        const response = await post(report);
        expect(response.status).toBe(503);
        expect(response.headers['retry-after']).toBe('2');
        expect(response.body.error.code).toBe('service_unavailable');
    });

    it('a resend with the same report_id is published again with a new accepted_at (stateless receiver)', async () => {
        as('lapangan');
        const first = await post(report);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = await post(report);
        expect([first.status, second.status]).toEqual([202, 202]);
        expect(publisher.publish).toHaveBeenCalledTimes(2);
        expect(second.body.accepted_at > first.body.accepted_at).toBe(true);
    });

    it('records latency and status metrics', async () => {
        as('lapangan');
        await post(report);
        const metrics = await request(app).get('/metrics');
        expect(metrics.text).toMatch(/bnpb_client_api_field_report_responses_total\{status="202"\} \d+/);
        expect(metrics.text).toMatch(/bnpb_client_api_field_report_accept_seconds_bucket/);
    });

    describe('GET /field-reports/{id}', () => {
        it('returns the stored report (processed) to lapangan, 404 when not stored yet, 403 to public', async () => {
            as('lapangan');
            gateway.find.mockResolvedValueOnce({ report_id: report.report_id, status: 'processed' });
            const found = await request(app).get(`/field-reports/${report.report_id}`).set('Authorization', 'Bearer t');
            expect(found.status).toBe(200);
            expect(found.body.status).toBe('processed');

            gateway.find.mockResolvedValueOnce(null);
            const missing = await request(app).get(`/field-reports/${report.report_id}`).set('Authorization', 'Bearer t');
            expect(missing.status).toBe(404);
            expect(missing.body.error.code).toBe('not_found');

            as('public');
            const forbidden = await request(app).get(`/field-reports/${report.report_id}`).set('Authorization', 'Bearer t');
            expect(forbidden.status).toBe(403);
            expect(forbidden.body).toEqual(FORBIDDEN);
        });
    });

    it('readiness fails while the producer is not connected', async () => {
        publisher.isReady.mockReturnValue(false);
        const response = await request(app).get('/health/ready');
        expect(response.status).toBe(503);
        expect(response.body.field_reports).toBe('connecting');
    });
});

describe('FieldReportPublisher', () => {
    const message = {
        v: 1 as const,
        report: report as never,
        reporter: { sub: 'u', role: 'lapangan' as const },
        accepted_at: new Date().toISOString(),
    };

    it('without brokers it is disabled: ready for probes, but every publish is unavailable', async () => {
        const publisher = new FieldReportPublisher();
        publisher.start();
        expect(publisher.isReady()).toBe(true);
        await expect(publisher.publish(message, 'c')).rejects.toMatchObject({ reason: 'disabled' });
    });

    it('waits for the connection within the timeout instead of rejecting at once, then gives up', async () => {
        const publisher = new FieldReportPublisher();
        const send = jest.fn().mockResolvedValue([{ partition: 2, baseOffset: '99' }]);
        Object.assign(publisher, { producer: { send }, connected: false });
        const started = Date.now();
        const pending = publisher.publish(message, 'c');
        setTimeout(() => {
            Object.assign(publisher, { connected: true });
            (publisher as unknown as { waiters: (() => void)[] }).waiters.splice(0).forEach((wake) => wake());
        }, 100);
        await expect(pending).resolves.toEqual({ partition: 2, offset: '99' });
        expect(Date.now() - started).toBeGreaterThanOrEqual(90);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ acks: -1, topic: 'field-reports' }));

        Object.assign(publisher, { connected: false });
        await expect(publisher.publish(message, 'c')).rejects.toMatchObject({ reason: 'not_connected' });
    });

    it('times out a send that never gets an ack', async () => {
        const publisher = new FieldReportPublisher();
        Object.assign(publisher, { producer: { send: () => new Promise(() => undefined) }, connected: true });
        await expect(publisher.publish(message, 'c')).rejects.toMatchObject({ reason: 'timeout' });
    });
});
