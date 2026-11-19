import { Attributes, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeSDK, NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { captureTrace, producerTrace, readTraceHeaders, traced, traceLogFields } from '../../src/telemetry/context';
import { UnprocessedRetryService } from '../../src/services/unprocessed-retry.service';
import { IUnprocessedMessageRepository } from '../../src/repositories/unprocessed-message.repository';
import { IUnprocessedHandlerRegistry } from '../../src/services/unprocessed-handler.registry';
import { IBackgroundLeadershipService } from '../../src/services/background-leadership.service';

it('keeps independent async flows isolated and restores an outbox parent for publishing and consuming', async () => {
    const exported: Array<{ name: string; attributes: Attributes; status: { code: SpanStatusCode } }> = [];
    const exporter: NonNullable<NodeSDKConfiguration['traceExporter']> = {
        export(spans, callback) {
            exported.push(...spans);
            callback({ code: 0 });
        },
        shutdown: async () => undefined,
    };
    const sdk = new NodeSDK({ traceExporter: exporter, instrumentations: [], autoDetectResources: false });
    sdk.start();
    try {
        const [first, second] = await Promise.all(
            ['flow-one', 'flow-two'].map((name) =>
                traced(name, {}, async () => {
                    await Promise.resolve();
                    return { carrier: captureTrace(), fields: traceLogFields() };
                })
            )
        );
        expect(first.fields.traceId).toMatch(/^[a-f0-9]{32}$/);
        expect(second.fields.traceId).not.toBe(first.fields.traceId);
        expect(traceLogFields()).toEqual({});

        const persisted = JSON.parse(JSON.stringify(first.carrier));
        const producer = producerTrace('hazard-events', persisted);
        expect(producer.span.spanContext().traceId).toBe(first.fields.traceId);
        const headers = Object.fromEntries(
            Object.entries(producer.headers).map(([key, value]) => [key, Buffer.from(value)])
        );
        await traced(
            'kafka.process',
            {},
            async () => {
                expect(traceLogFields().traceId).toBe(first.fields.traceId);
                expect(trace.getActiveSpan()?.spanContext().spanId).not.toBe(producer.span.spanContext().spanId);
            },
            readTraceHeaders(headers),
            SpanKind.CONSUMER
        );
        producer.span.end();
        const entry = {
            messageId: 'retry-entry',
            source: 'PVMBG',
            context: { kind: 'poll.volcanic-report' },
            correlationId: 'original-poll',
            attempts: 1,
            traceContext: persisted,
        };
        const repository = {
            findDueIds: async () => [entry.messageId],
            claim: async () => entry,
            readPayload: async () => Buffer.from('{}'),
            complete: jest.fn(async () => {
                expect(traceLogFields().traceId).toBe(first.fields.traceId);
                return true;
            }),
        };
        const handler = jest.fn(async () => {
            expect(traceLogFields().traceId).toBe(first.fields.traceId);
            expect(captureTrace().traceparent).toContain(first.fields.traceId);
            return { hazardId: 'recovered-hazard' };
        });
        const worker = new UnprocessedRetryService(
            repository as unknown as IUnprocessedMessageRepository,
            { get: () => handler } as unknown as IUnprocessedHandlerRegistry,
            { current: () => ({ ownerId: 'test-owner', epoch: 1 }) } as IBackgroundLeadershipService
        );
        expect(await worker.runOnce()).toBe(1);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(repository.complete).toHaveBeenCalledWith(entry, expect.anything(), {
            kind: 'recovered',
            hazardId: 'recovered-hazard',
        });
        await expect(
            traced('failed-work', {}, async () => {
                throw new Error('private database details');
            })
        ).rejects.toThrow();
        expect(
            readTraceHeaders({ authorization: 'secret', traceparent: ['invalid'], tracestate: 'x'.repeat(513) })
        ).toEqual({});
    } finally {
        await sdk.shutdown();
    }
    const failure = exported.find((span) => span.name === 'failed-work');
    expect(failure?.status.code).toBe(SpanStatusCode.ERROR);
    expect(failure?.attributes['error.type']).toBe('Error');
    expect(JSON.stringify(exported.map((span) => span.attributes))).not.toContain('private database details');
});
