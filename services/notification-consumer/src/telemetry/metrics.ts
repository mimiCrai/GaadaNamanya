import { NextFunction, Request, Response, Application } from 'express';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export const metricsRegistry = new Registry();
metricsRegistry.setDefaultLabels({
    service: process.env.OTEL_SERVICE_NAME ?? process.env.SERVICE_NAME ?? 'notification-consumer',
});
if (process.env.NODE_ENV !== 'test') collectDefaultMetrics({ register: metricsRegistry });

export function installHttpMetrics(app: Application, registry: Registry = metricsRegistry, serveEndpoint = true): void {
    const requests =
        (registry.getSingleMetric('bnpb_http_requests_total') as Counter<string> | undefined) ??
        new Counter({
            name: 'bnpb_http_requests_total',
            help: 'Completed HTTP requests',
            labelNames: ['method', 'route', 'status_code', 'role'],
            registers: [registry],
        });
    const duration =
        (registry.getSingleMetric('bnpb_http_request_duration_seconds') as Histogram<string> | undefined) ??
        new Histogram({
            name: 'bnpb_http_request_duration_seconds',
            help: 'HTTP request duration',
            labelNames: ['method', 'route', 'status_code', 'role'],
            buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
            registers: [registry],
        });
    const active =
        (registry.getSingleMetric('bnpb_http_requests_active') as Gauge<string> | undefined) ??
        new Gauge({ name: 'bnpb_http_requests_active', help: 'Active HTTP requests', registers: [registry] });
    app.use((req: Request, res: Response, next: NextFunction) => {
        if (/^\/(?:health|healthz|metrics)(?:\/|$)/.test(req.path)) return next();
        const started = performance.now();
        active.inc();
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            active.dec();
            const role: unknown = res.locals.authRole;
            const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method)
                ? req.method
                : 'OTHER';
            const labels = {
                method,
                route: typeof req.route?.path === 'string' ? `${req.baseUrl}${req.route.path}` : 'unmatched',
                status_code: String(res.writableFinished ? res.statusCode : 499),
                role: ['public', 'lapangan', 'internal'].includes(String(role)) ? String(role) : 'anonymous',
            };
            requests.inc(labels);
            duration.observe(labels, (performance.now() - started) / 1000);
        };
        res.once('finish', finish);
        res.once('close', finish);
        next();
    });
    if (serveEndpoint)
        app.get('/metrics', async (_req, res, next) => {
            try {
                res.type(registry.contentType).send(await registry.metrics());
            } catch (error) {
                next(error);
            }
        });
}
