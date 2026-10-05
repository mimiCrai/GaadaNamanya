import { Request, Response } from 'express';
import { ListQuery } from '../repositories/report.store';
import { sendError } from '../libs/http-error';
import { ListQuerySchema } from '../types/contract';

// parse "since" and "limit"
export function parseListQuery(req: Request, res: Response): ListQuery | undefined {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
        sendError(res, 400, 'invalid_query', `Invalid query parameters (${detail})`);
        return undefined;
    }

    return {
        since: parsed.data.since === undefined ? undefined : new Date(parsed.data.since),
        limit: parsed.data.limit,
    };
}

export function sendList<T>(req: Request, res: Response, data: T[]): Response {
    return res.json({
        data,
        meta: {
            count: data.length,
            since: typeof req.query.since === 'string' ? req.query.since : null,
            server_time: new Date().toISOString(),
        },
    });
}
