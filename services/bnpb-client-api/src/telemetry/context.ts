import { context, propagation, trace, isSpanContextValid } from '@opentelemetry/api';

// W3C trace context for Kafka headers (field reports, D-38); empty when the SDK is disabled
export function captureTrace(): Record<string, string> {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return carrier;
}

export function traceLogFields(): Record<string, string> {
    const span = trace.getActiveSpan()?.spanContext();
    return span && isSpanContextValid(span) ? { traceId: span.traceId, spanId: span.spanId } : {};
}

export function annotateCorrelation(correlationId: string): void {
    trace.getActiveSpan()?.setAttribute('correlation.id', correlationId);
}
