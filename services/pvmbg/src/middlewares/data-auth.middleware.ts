import { NextFunction, Request, Response } from 'express';
import { inject, injectable } from 'inversify';
import { BaseMiddleware } from 'inversify-express-utils';
import { AppConfig, PVMBG_TOKEN_PATTERN } from '../config/env';
import { TYPES } from '../constants/types';
import { matchesAny } from '../libs/credentials';
import { sendError } from '../libs/http-error';
import '../types/locals';

const WWW_AUTHENTICATE = 'Bearer realm="pvmbg"';
const BEARER_PATTERN = /^Bearer\s+(\S+)\s*$/i;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const INVALID_CREDENTIAL_MESSAGE = 'Invalid credential';

@injectable()
export class DataAuthMiddleware extends BaseMiddleware {
    constructor(@inject(TYPES.Config) private readonly config: AppConfig) {
        super();
    }

    handler(req: Request, res: Response, next: NextFunction): void {
        const bearer = req.header('authorization')?.match(BEARER_PATTERN)?.[1];
        const isPvmbgShaped = bearer?.toLowerCase().startsWith('pvmbg.') ?? false;

        if (
            req.header('x-bmkg-key') !== undefined ||
            (bearer !== undefined && !isPvmbgShaped && JWT_PATTERN.test(bearer))
        ) {
            res.locals.authResult = 'foreign_credential';
            sendError(res, 403, 'invalid_credential', INVALID_CREDENTIAL_MESSAGE);
            return;
        }

        if (bearer === undefined) {
            res.locals.authResult = 'missing';
            res.setHeader('WWW-Authenticate', WWW_AUTHENTICATE);
            sendError(res, 401, 'missing_credential', 'Authorization: Bearer <token> header is required');
            return;
        }

        if (!PVMBG_TOKEN_PATTERN.test(bearer) || !matchesAny(bearer, this.config.clientTokens)) {
            res.locals.authResult = 'invalid';
            sendError(res, 403, 'invalid_credential', INVALID_CREDENTIAL_MESSAGE);
            return;
        }

        res.locals.authResult = 'ok';
        next();
    }
}
