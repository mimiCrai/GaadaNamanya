import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

export let telemetry: NodeSDK | undefined;

// Import first in server.ts so libraries load after instrumentation.
if (process.env.OTEL_SDK_DISABLED === 'false') {
    const endpoint = new URL(process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318');
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('OTLP endpoint must use HTTP(S)');
    process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS = 'http,express,undici,mongodb,pg';
    process.env.OTEL_NODE_RESOURCE_DETECTORS = 'env,process,host';
    process.env.OTEL_LOGS_EXPORTER = 'none';
    process.env.OTEL_METRICS_EXPORTER = 'none';
    telemetry = new NodeSDK({
        resource: resourceFromAttributes({
            'service.name': process.env.OTEL_SERVICE_NAME ?? process.env.SERVICE_NAME ?? 'notification-consumer',
        }),
        traceExporter: new OTLPTraceExporter({
            url: endpoint.toString().replace(/\/$/, '') + '/v1/traces',
            timeoutMillis: Number(process.env.OTEL_EXPORTER_OTLP_TIMEOUT ?? 3000),
        }),
        instrumentations: [
            getNodeAutoInstrumentations({
                '@opentelemetry/instrumentation-http': {
                    ignoreIncomingRequestHook: (request) =>
                        /^\/(?:health|healthz|metrics)(?:\/|$|\?)/.test(request.url ?? ''),
                },
                '@opentelemetry/instrumentation-mongodb': { enhancedDatabaseReporting: false, requireParentSpan: true },
                '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: false, requireParentSpan: true },
            }),
        ],
    });
    telemetry.start();
}
export async function shutdownTelemetry(): Promise<void> {
    await telemetry?.shutdown();
}
