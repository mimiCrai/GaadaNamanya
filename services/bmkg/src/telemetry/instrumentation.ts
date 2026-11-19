import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

let telemetry: NodeSDK | undefined;

// Import first in server.ts so libraries load after instrumentation.
if (process.env.OTEL_SDK_DISABLED === 'false') {
    const endpoint = new URL(process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318');
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('OTLP endpoint must use HTTP(S)');
    process.env.OTEL_LOGS_EXPORTER = 'none';
    process.env.OTEL_METRICS_EXPORTER = 'none';
    telemetry = new NodeSDK({
        resource: resourceFromAttributes({
            'service.name': process.env.OTEL_SERVICE_NAME ?? process.env.SERVICE_NAME ?? 'bmkg',
        }),
        traceExporter: new OTLPTraceExporter({
            url: endpoint.toString().replace(/\/$/, '') + '/v1/traces',
            timeoutMillis: 3000,
        }),
        instrumentations: [
            new HttpInstrumentation({
                ignoreIncomingRequestHook: (request) =>
                    /^\/(?:health|healthz|metrics)(?:\/|$|\?)/.test(request.url ?? ''),
            }),
            new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE] }),
            new UndiciInstrumentation(),
            new PgInstrumentation({ enhancedDatabaseReporting: false, requireParentSpan: true }),
        ],
    });
    telemetry.start();
}

export async function shutdownTelemetry(): Promise<void> {
    await telemetry?.shutdown();
}
