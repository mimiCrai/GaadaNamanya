import { trace, isSpanContextValid } from '@opentelemetry/api';

export function traceLogFields(): Record<string, string> {
    const span = trace.getActiveSpan()?.spanContext();
    return span && isSpanContextValid(span) ? { traceId: span.traceId, spanId: span.spanId } : {};
}

export function annotateCorrelation(correlationId: string): void {
    trace.getActiveSpan()?.setAttribute('correlation.id', correlationId);
}
