import { NextFunction, Request, Response } from 'express';
import { inject, injectable } from 'inversify';
import { BaseMiddleware } from 'inversify-express-utils';
import { AppConfig } from '../config/env';
import { TYPES } from '../constants/types';
import { matchesAny } from '../libs/credentials';
import { sendError } from '../libs/http-error';
import '../types/locals';

// /admin/* accepts only X-Admin-Token
@injectable()
export class AdminAuthMiddleware extends BaseMiddleware {
    constructor(@inject(TYPES.Config) private readonly config: AppConfig) {
        super();
    }

    handler(req: Request, res: Response, next: NextFunction): void {
        const adminToken = req.header('x-admin-token');

        if (adminToken === undefined || adminToken.length === 0) {
            if (req.header('authorization') !== undefined || req.header('x-bmkg-key') !== undefined) {
                res.locals.authResult = 'foreign_credential';
                sendError(res, 403, 'foreign_credential', 'Data credentials are not accepted on admin endpoints');
                return;
            }
            res.locals.authResult = 'missing';
            sendError(res, 401, 'missing_credential', 'X-Admin-Token header is required');
            return;
        }

        if (!matchesAny(adminToken, [this.config.adminToken])) {
            res.locals.authResult = 'invalid';
            sendError(res, 403, 'invalid_credential', 'X-Admin-Token is not recognised');
            return;
        }

        res.locals.authResult = 'ok';
        next();
    }
}
