import { timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { injectable } from 'inversify';
import { BaseMiddleware } from 'inversify-express-utils';
import env from '../util/env';

export const INTERNAL_API_KEY_HEADER = 'X-BNPB-Internal-Key';

/** Authenticates trusted BNPB service-to-service calls to /internal routes. */
@injectable()
export class InternalAuthMiddleware extends BaseMiddleware {
    handler(req: Request, res: Response, next: NextFunction): void {
        const suppliedKey = req.header(INTERNAL_API_KEY_HEADER);
        if (!suppliedKey) {
            res.setHeader('WWW-Authenticate', `ApiKey header="${INTERNAL_API_KEY_HEADER}"`);
            res.status(401).json({ error: { message: `${INTERNAL_API_KEY_HEADER} header is required` } });
            return;
        }

        const expectedKey = Buffer.from(env.BNPB_INTERNAL_API_KEY);
        const actualKey = Buffer.from(suppliedKey);
        const matches = actualKey.length === expectedKey.length && timingSafeEqual(actualKey, expectedKey);
        if (!matches) {
            res.status(403).json({ error: { message: `${INTERNAL_API_KEY_HEADER} is not recognised` } });
            return;
        }

        next();
    }
}
