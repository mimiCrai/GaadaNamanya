import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, request, requestParam, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { classificationForRole, HAZARD_SOURCES, IHazardGateway } from '../services/hazard-gateway.service';
import { IJwtAuthenticator } from '../services/jwt-authenticator.service';

@controller('/hazards')
export class HazardController {
    constructor(
        @inject(TYPES.JwtAuthenticator) private jwtAuthenticator: IJwtAuthenticator,
        @inject(TYPES.HazardGateway) private hazardGateway: IHazardGateway
    ) {}

    @httpGet('/')
    async list(@request() request: Request, @response() res: Response) {
        const auth = await this.jwtAuthenticator.authenticate(
            request.header('authorization'),
            res.locals.correlationId
        );
        const source = HAZARD_SOURCES.find((value) => value === request.query.source);
        const result = await this.hazardGateway.list(
            classificationForRole(auth.role),
            res.locals.correlationId,
            source
        );
        return res.json(result);
    }

    @httpGet('/:hazardId')
    async getById(@requestParam('hazardId') hazardId: string, @request() request: Request, @response() res: Response) {
        const auth = await this.jwtAuthenticator.authenticate(
            request.header('authorization'),
            res.locals.correlationId
        );
        const result = await this.hazardGateway.getById(
            hazardId,
            classificationForRole(auth.role),
            res.locals.correlationId
        );
        return res.json(result);
    }
}
