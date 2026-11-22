import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, request, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { ApiError } from '../errors/api-error';
import { IDlqGateway } from '../services/dlq-gateway.service';
import { IJwtAuthenticator } from '../services/jwt-authenticator.service';

// P4 #2: late and single detection counts for BNPB Internal Ops (role internal), enforced on the server
@controller('/internal-ops/satellite')
export class InternalOpsSatelliteController {
    constructor(
        @inject(TYPES.JwtAuthenticator) private readonly jwtAuthenticator: IJwtAuthenticator,
        @inject(TYPES.DlqGateway) private readonly gateway: IDlqGateway
    ) {}

    @httpGet('/summary')
    async summary(@request() req: Request, @response() res: Response) {
        const auth = await this.jwtAuthenticator.authenticate(req.header('authorization'), res.locals.correlationId);
        res.locals.authRole = auth.role;
        if (auth.role !== 'internal') {
            throw new ApiError('Hanya BNPB Internal Ops yang boleh melihat ringkasan pemrosesan satelit', 403, 'forbidden');
        }
        return res.json(await this.gateway.satelliteSummary(res.locals.correlationId));
    }
}
