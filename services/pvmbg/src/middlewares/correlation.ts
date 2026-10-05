import { randomUUID } from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { Logger } from 'pino';
import '../types/locals';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function correlationMiddleware(logger: Logger): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        const incoming = req.header('x-correlation-id');
        const correlationId = incoming !== undefined && UUID_PATTERN.test(incoming) ? incoming : randomUUID();

        res.locals.correlationId = correlationId;
        res.locals.logger = logger.child({ correlation_id: correlationId });
        res.locals.authResult = 'skipped';
        res.locals.injectedDelayMs = 0;
        res.setHeader('X-Correlation-ID', correlationId);
        next();
    };
}
