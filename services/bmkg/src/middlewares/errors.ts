import { NextFunction, Request, Response } from 'express';
import { sendError } from '../libs/http-error';
import '../types/locals';

export function notFoundHandler(req: Request, res: Response): void {
    sendError(res, 404, 'not_found', `No route for ${req.method} ${req.path}`);
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
    res.locals.logger.error({ err }, 'Unhandled request error');
    sendError(res, 500, 'internal_error', 'Internal server error');
}
