import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, request, requestParam, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { ApiError } from '../errors/api-error';
import { classificationForRole, IHazardGateway } from '../services/hazard-gateway.service';
import { IJwtAuthenticator } from '../services/jwt-authenticator.service';

@controller('/hazards')
export class HazardController {
    constructor(
        @inject(TYPES.JwtAuthenticator) private jwtAuthenticator: IJwtAuthenticator,
        @inject(TYPES.HazardGateway) private hazardGateway: IHazardGateway
    ) {}

    @httpGet('/')
    async list(@request() request: Request, @response() res: Response) {
        try {
            const auth = await this.jwtAuthenticator.authenticate(request.header('authorization'));
            const hazards = await this.hazardGateway.list(classificationForRole(auth.role));
            return res.json({ data: hazards });
        } catch (error) {
            return handleError(error, res);
        }
    }

    @httpGet('/:hazardId')
    async getById(@requestParam('hazardId') hazardId: string, @request() request: Request, @response() res: Response) {
        try {
            const auth = await this.jwtAuthenticator.authenticate(request.header('authorization'));
            const hazard = await this.hazardGateway.getById(hazardId, classificationForRole(auth.role));
            return res.json({ data: hazard });
        } catch (error) {
            return handleError(error, res);
        }
    }
}

function handleError(error: unknown, res: Response) {
    if (error instanceof ApiError) return res.status(error.status).json({ error: { message: error.message } });
    throw error;
}
