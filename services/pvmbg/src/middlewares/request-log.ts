import { NextFunction, Request, Response } from 'express';
import '../types/locals';

export function requestLogMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    const path = req.originalUrl.split('?')[0];

    res.once('close', () => {
        const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const aborted = !res.writableFinished;
        const status = res.statusCode;
        const level = status >= 500 ? 'error' : status >= 400 || aborted ? 'warn' : 'info';

        res.locals.logger[level](
            {
                method: req.method,
                path,
                status,
                latency_ms: Math.round(latencyMs * 10) / 10,
                injected_delay_ms: res.locals.injectedDelayMs,
                auth_result: res.locals.authResult,
                ...(aborted && { aborted: true }),
            },
            'Request completed'
        );
    });

    next();
}
