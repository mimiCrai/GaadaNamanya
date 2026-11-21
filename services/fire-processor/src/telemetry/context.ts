import { isSpanContextValid, trace } from '@opentelemetry/api';

// trace/span ids in every log line while a span is active (B's convention)
export function traceLogFields(): Record<string, string> {
    const span = trace.getActiveSpan()?.spanContext();
    return span && isSpanContextValid(span) ? { traceId: span.traceId, spanId: span.spanId } : {};
}
