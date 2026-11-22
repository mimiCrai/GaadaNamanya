import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { NodeSDK, NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { batchTrace, readTraceHeaders, traced, traceLogFields, TraceCarrier } from '../../src/telemetry/context';

type Exported = Parameters<NonNullable<NodeSDKConfiguration['traceExporter']>['export']>[0][number];

it('continues the satellite.raw producer trace: consumer span, flush child, linked extra producers', async () => {
    const exported: Exported[] = [];
    const sdk = new NodeSDK({
        traceExporter: {
            export(spans, callback) {
                exported.push(...spans);
                callback({ code: 0 });
            },
            shutdown: async () => undefined,
        },
        instrumentations: [],
        autoDetectResources: false,
    });
    sdk.start();
    try {
        // two Aggregator appends landed in one Kafka batch
        const producers = await Promise.all(
            ['append-1', 'append-2'].map((name) =>
                traced(name, {}, async () => {
                    const carrier: TraceCarrier = {};
                    propagation.inject(context.active(), carrier);
                    return carrier;
                })
            )
        );
        const kafkaHeaders = [producers[0], producers[0], producers[1], {}].map((carrier) =>
            Object.fromEntries(Object.entries(carrier).map(([key, value]) => [key, Buffer.from(value)]))
        );
        const { parent, links } = batchTrace(kafkaHeaders.map((headers) => readTraceHeaders(headers)));
        expect(parent).toEqual(producers[0]);
        expect(links).toHaveLength(1);

        const producerTraceId = producers[0].traceparent.split('-')[1];
        await traced(
            'satellite.raw process',
            {},
            async () => {
                expect(traceLogFields().traceId).toBe(producerTraceId);
                await traced('fire.flush', {}, async () => {
                    // what UndiciInstrumentation injects into the Aggregator request
                    const outbound: TraceCarrier = {};
                    propagation.inject(context.active(), outbound);
                    expect(outbound.traceparent.split('-')[1]).toBe(producerTraceId);
                });
            },
            parent,
            SpanKind.CONSUMER,
            links
        );
        expect(trace.getActiveSpan()).toBeUndefined();
    } finally {
        await sdk.shutdown();
    }
    const consumer = exported.find((span) => span.name === 'satellite.raw process')!;
    const flush = exported.find((span) => span.name === 'fire.flush')!;
    expect(consumer.kind).toBe(SpanKind.CONSUMER);
    expect(consumer.links).toHaveLength(1);
    expect(flush.spanContext().traceId).toBe(consumer.spanContext().traceId);
    expect(flush.parentSpanContext?.spanId ?? (flush as unknown as { parentSpanId?: string }).parentSpanId).toBe(
        consumer.spanContext().spanId
    );
});

it('a batch without trace headers starts its own trace', () => {
    expect(batchTrace([{}, readTraceHeaders({ traceparent: 'x'.repeat(600) })])).toEqual({
        parent: undefined,
        links: [],
    });
});
