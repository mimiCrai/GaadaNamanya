import { NextFunction, Request, Response } from 'express';
import { inject, injectable } from 'inversify';
import { BaseMiddleware } from 'inversify-express-utils';
import { AppConfig, BMKG_API_KEY_PATTERN } from '../config/env';
import { TYPES } from '../constants/types';
import { matchesAny } from '../libs/credentials';
import { sendError } from '../libs/http-error';
import '../types/locals';

const WWW_AUTHENTICATE = 'ApiKey realm="bmkg", header="X-BMKG-Key"';
const BEARER_PATTERN = /^Bearer\s+(\S+)\s*$/i;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;


@injectable()
export class DataAuthMiddleware extends BaseMiddleware {
    constructor(@inject(TYPES.Config) private readonly config: AppConfig) {
        super();
    }

    handler(req: Request, res: Response, next: NextFunction): void {
        const bearer = req.header('authorization')?.match(BEARER_PATTERN)?.[1];
        if (bearer !== undefined && (bearer.toLowerCase().startsWith('pvmbg.') || JWT_PATTERN.test(bearer))) {
            res.locals.authResult = 'foreign_credential';
            sendError(res, 403, 'foreign_credential', 'Credentials issued by another agency are not accepted by BMKG');
            return;
        }

        const apiKey = req.header('x-bmkg-key');
        if (apiKey === undefined || apiKey.length === 0) {
            res.locals.authResult = 'missing';
            res.setHeader('WWW-Authenticate', WWW_AUTHENTICATE);
            sendError(res, 401, 'missing_credential', 'X-BMKG-Key header is required');
            return;
        }

        if (!BMKG_API_KEY_PATTERN.test(apiKey)) {
            res.locals.authResult = 'invalid';
            res.setHeader('WWW-Authenticate', WWW_AUTHENTICATE);
            sendError(res, 401, 'malformed_credential', 'X-BMKG-Key must have the format bmkg_<keyid>_<32 hex>');
            return;
        }

        if (!matchesAny(apiKey, this.config.apiKeys)) {
            res.locals.authResult = 'invalid';
            sendError(res, 403, 'invalid_credential', 'X-BMKG-Key is not recognised');
            return;
        }

        res.locals.authResult = 'ok';
        next();
    }
}
