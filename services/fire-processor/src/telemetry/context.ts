import {
    Attributes,
    context,
    Link,
    propagation,
    ROOT_CONTEXT,
    SpanKind,
    SpanStatusCode,
    trace,
    isSpanContextValid,
} from '@opentelemetry/api';

export type TraceCarrier = Record<string, string>;
const tracer = trace.getTracer('bnpb');
const MAX_LINKS = 32;

// trace/span ids in every log line while a span is active (B's convention)
export function traceLogFields(): Record<string, string> {
    const span = trace.getActiveSpan()?.spanContext();
    return span && isSpanContextValid(span) ? { traceId: span.traceId, spanId: span.spanId } : {};
}

// traceparent/tracestate written by the Aggregator satellite.raw producer (pattern of dashboard-consumer)
export function readTraceHeaders(headers: Record<string, unknown> = {}): TraceCarrier {
    const carrier: TraceCarrier = {};
    for (const name of ['traceparent', 'tracestate']) {
        const value = headers[name];
        const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
        if (typeof text === 'string' && text.length <= 512) carrier[name] = text;
    }
    return carrier;
}

export async function traced<T>(
    name: string,
    attributes: Attributes,
    work: () => Promise<T>,
    carrier?: TraceCarrier,
    kind = SpanKind.INTERNAL,
    links: Link[] = []
): Promise<T> {
    const parent = carrier ? propagation.extract(ROOT_CONTEXT, carrier) : context.active();
    return tracer.startActiveSpan(name, { attributes, kind, links }, parent, async (span) => {
        try {
            return await work();
        } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.setAttribute('error.type', error instanceof Error ? error.name : 'Error');
            throw error;
        } finally {
            span.end();
        }
    });
}

// one Kafka batch: child of the first producer span, linked to the other producer spans in the batch
export function batchTrace(carriers: TraceCarrier[]): { parent: TraceCarrier | undefined; links: Link[] } {
    const seen = new Set<string>();
    let parent: TraceCarrier | undefined;
    const links: Link[] = [];
    for (const carrier of carriers) {
        if (!carrier.traceparent || seen.has(carrier.traceparent)) continue;
        seen.add(carrier.traceparent);
        if (!parent) {
            parent = carrier;
            continue;
        }
        if (links.length >= MAX_LINKS) break;
        const spanContext = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, carrier));
        if (spanContext && isSpanContextValid(spanContext)) links.push({ context: spanContext });
    }
    return { parent, links };
}
