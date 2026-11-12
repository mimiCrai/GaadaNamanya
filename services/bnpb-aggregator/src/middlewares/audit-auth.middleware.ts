import { timingSafeEqual } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { injectable } from 'inversify';
import { BaseMiddleware } from 'inversify-express-utils';
import env from '../util/env';

@injectable()
export class AuditAuthMiddleware extends BaseMiddleware {
    handler(req: Request, res: Response, next: NextFunction): void {
        const match = /^Bearer ([^\s]+)$/i.exec(req.header('authorization') ?? '');
        const token = Buffer.from(match?.[1] ?? '');
        const expected = Buffer.from(env.BNPB_AUDIT_TOKEN);
        if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
            res.setHeader('WWW-Authenticate', 'Bearer');
            res.status(401).json({ error: { code: 'unauthorized', message: 'Invalid or missing audit token' } });
            return;
        }
        next();
    }
}
