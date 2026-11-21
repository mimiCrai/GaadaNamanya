import { Attributes, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeSDK, NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { captureTrace, producerTrace, readTraceHeaders, traced, traceLogFields } from '../../src/telemetry/context';

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
