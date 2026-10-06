import { NextFunction, Request, Response } from 'express';
import { inject, injectable } from 'inversify';
import { BaseMiddleware } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { sendError } from '../libs/http-error';
import { OutageService } from '../services/outage.service';
import '../types/locals';

// runs first on the data endpoint and /health
@injectable()
export class OutageMiddleware extends BaseMiddleware {
    constructor(@inject(TYPES.OutageService) private readonly outage: OutageService) {
        super();
    }

    handler(_req: Request, res: Response, next: NextFunction): void {
        switch (this.outage.active) {
            case undefined:
                next();
                return;
            case 'error':
                sendError(res, 503, 'service_unavailable', 'PVMBG is temporarily unavailable');
                return;
            case 'hang':
                this.outage.hold(res);
                return;
        }
    }
}
