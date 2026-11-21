import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, request, requestParam, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { classificationForRole, HAZARD_SOURCES, IHazardGateway } from '../services/hazard-gateway.service';
import { IJwtAuthenticator } from '../services/jwt-authenticator.service';
import { IAdmissionControlService } from '../services/admission-control.service';
import { UserRole } from '../types/auth';
import { logger } from '../libs/logger';
import env from '../util/env';

@controller('/hazards')
export class HazardController {
    constructor(
        @inject(TYPES.JwtAuthenticator) private jwtAuthenticator: IJwtAuthenticator,
        @inject(TYPES.HazardGateway) private hazardGateway: IHazardGateway,
        @inject(TYPES.IAdmissionControlService) private admissionControl: IAdmissionControlService
    ) {}

    @httpGet('/')
    async list(@request() request: Request, @response() res: Response) {
        const auth = await this.jwtAuthenticator.authenticate(
            request.header('authorization'),
            res.locals.correlationId
        );
        const source = HAZARD_SOURCES.find((value) => value === request.query.source);
        res.locals.authRole = auth.role;
        return this.withAdmission(auth.role, request, res, () =>
            this.hazardGateway.list(classificationForRole(auth.role), res.locals.correlationId, source)
        );
    }

    @httpGet('/:hazardId')
    async getById(@requestParam('hazardId') hazardId: string, @request() request: Request, @response() res: Response) {
        const auth = await this.jwtAuthenticator.authenticate(
            request.header('authorization'),
            res.locals.correlationId
        );
        res.locals.authRole = auth.role;
        return this.withAdmission(auth.role, request, res, () =>
            this.hazardGateway.getById(hazardId, classificationForRole(auth.role), res.locals.correlationId)
        );
    }

    private async withAdmission(role: UserRole, req: Request, res: Response, work: () => Promise<unknown>) {
        const permit = this.admissionControl.tryAcquire(role);
        if (!permit) {
            logger.warn(
                { role, path: req.path, correlationId: res.locals.correlationId },
                'Rejected hazard request at concurrency limit'
            );
            return res
                .set('Retry-After', String(env.ADMISSION_RETRY_AFTER_SECONDS))
                .status(503)
                .json({ error: { message: 'Service Unavailable' } });
        }
        try {
            return res.json(await work());
        } finally {
            permit.release();
        }
    }
}
