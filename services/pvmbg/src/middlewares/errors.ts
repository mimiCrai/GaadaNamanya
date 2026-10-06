import { NextFunction, Request, Response } from 'express';
import { sendError } from '../libs/http-error';
import '../types/locals';

interface BodyParserError extends Error {
    type?: string;
    status?: number;
}

export function notFoundHandler(req: Request, res: Response): void {
    sendError(res, 404, 'not_found', `No route for ${req.method} ${req.path}`);
}

export function errorHandler(err: BodyParserError, _req: Request, res: Response, _next: NextFunction): void {
    // malformed or oversized JSON on /admin/*
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
        sendError(res, err.status ?? 400, 'invalid_body', `Invalid request body (${err.message})`);
        return;
    }

    res.locals.logger.error({ err }, 'Unhandled request error');
    sendError(res, 500, 'internal_error', 'Internal server error');
}
