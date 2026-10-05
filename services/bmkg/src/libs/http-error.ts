import { Response } from 'express';

export type ErrorCode =
    | 'missing_credential'
    | 'malformed_credential'
    | 'invalid_credential'
    | 'foreign_credential'
    | 'invalid_query'
    | 'not_found'
    | 'internal_error';

export function sendError(res: Response, status: number, error: ErrorCode, message: string): Response {
    return res.status(status).json({ error, message, correlation_id: res.locals.correlationId });
}
