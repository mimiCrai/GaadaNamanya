import {
    Attributes,
    context,
    propagation,
    ROOT_CONTEXT,
    Span,
    SpanKind,
    SpanStatusCode,
    trace,
    isSpanContextValid,
} from '@opentelemetry/api';

export type TraceCarrier = Record<string, string>;
const tracer = trace.getTracer('bnpb');

export function captureTrace(): TraceCarrier {
    const carrier: TraceCarrier = {};
    propagation.inject(context.active(), carrier);
    return carrier;
}

export function readTraceHeaders(headers: Record<string, unknown> = {}): TraceCarrier {
    const carrier: TraceCarrier = {};
    for (const name of ['traceparent', 'tracestate']) {
        const value = headers[name];
        const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
        if (typeof text === 'string' && text.length <= 512) carrier[name] = text;
    }
    return carrier;
}

export function traceLogFields(): Record<string, string> {
    const span = trace.getActiveSpan()?.spanContext();
    return span && isSpanContextValid(span) ? { traceId: span.traceId, spanId: span.spanId } : {};
}

export function annotateCorrelation(correlationId: string): void {
    trace.getActiveSpan()?.setAttribute('correlation.id', correlationId);
}

export function failSpan(span: Span, error: unknown): void {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute('error.type', error instanceof Error ? error.name : 'Error');
}

export function markActiveSpanError(error: unknown): void {
    const span = trace.getActiveSpan();
    if (span) failSpan(span, error);
}

export async function traced<T>(
    name: string,
    attributes: Attributes,
    work: () => Promise<T>,
    carrier?: TraceCarrier,
    kind = SpanKind.INTERNAL
): Promise<T> {
    const parent = carrier ? propagation.extract(ROOT_CONTEXT, carrier) : context.active();
    return tracer.startActiveSpan(name, { attributes, kind }, parent, async (span) => {
        try {
            return await work();
        } catch (error) {
            failSpan(span, error);
            throw error;
        } finally {
            span.end();
        }
    });
}

export function producerTrace(topic: string, carrier: TraceCarrier, attributes: Attributes = {}) {
    const parent = Object.keys(carrier).length ? propagation.extract(ROOT_CONTEXT, carrier) : context.active();
    const span = tracer.startSpan(
        'kafka.publish',
        {
            kind: SpanKind.PRODUCER,
            attributes: { 'messaging.system': 'kafka', 'messaging.destination.name': topic, ...attributes },
        },
        parent
    );
    const headers: TraceCarrier = {};
    propagation.inject(trace.setSpan(parent, span), headers);
    return { span, headers };
}
