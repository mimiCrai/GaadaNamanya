import { NextFunction, Request, Response } from 'express';
import { inject, injectable } from 'inversify';
import { BaseMiddleware } from 'inversify-express-utils';
import { AppConfig } from '../config/env';
import { TYPES } from '../constants/types';
import '../types/locals';


// artificial delay
@injectable()
export class DelayMiddleware extends BaseMiddleware {
    constructor(@inject(TYPES.Config) private readonly config: AppConfig) {
        super();
    }

    handler(_req: Request, res: Response, next: NextFunction): void {
        const { delayMinMs: min, delayMaxMs: max } = this.config;
        const delayMs = min === max ? min : min + Math.floor(Math.random() * (max - min + 1));

        res.locals.injectedDelayMs = delayMs;
        if (delayMs === 0) {
            next();
            return;
        }
        setTimeout(next, delayMs);
    }
}
