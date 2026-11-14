import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, request, requestParam, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { ApiError } from '../errors/api-error';
import { DlqListQuery, IDlqGateway } from '../services/dlq-gateway.service';
import { IJwtAuthenticator } from '../services/jwt-authenticator.service';

const LIST_PARAMS = ['source', 'status', 'limit', 'cursor'] as const;

/**
 * P3 #5: unprocessed messages can only be inspected by BNPB Internal Ops (role `internal`).
 * Enforced here on the server: Media (`public`) and Tim Lapangan (`lapangan`) get 403.
 */
@controller('/internal-ops/dlq')
export class InternalOpsDlqController {
    constructor(
        @inject(TYPES.JwtAuthenticator) private readonly jwtAuthenticator: IJwtAuthenticator,
        @inject(TYPES.DlqGateway) private readonly dlqGateway: IDlqGateway
    ) {}

    @httpGet('/')
    async list(@request() req: Request, @response() res: Response) {
        await this.requireInternalOps(req, res);
        const query: DlqListQuery = {};
        for (const name of LIST_PARAMS) {
            // The OpenAPI validator coerces `limit` to a number.
            const value: unknown = req.query[name];
            if (typeof value === 'string' || typeof value === 'number') query[name] = String(value);
        }
        return res.json(await this.dlqGateway.list(query, res.locals.correlationId));
    }

    @httpGet('/:messageId')
    async detail(@requestParam('messageId') messageId: string, @request() req: Request, @response() res: Response) {
        await this.requireInternalOps(req, res);
        return res.json(await this.dlqGateway.detail(messageId, res.locals.correlationId));
    }

    @httpGet('/:messageId/raw')
    async raw(@requestParam('messageId') messageId: string, @request() req: Request, @response() res: Response) {
        await this.requireInternalOps(req, res);
        const payload = await this.dlqGateway.raw(messageId, res.locals.correlationId);
        res.status(200).set(payload.headers);
        await pipeline(Readable.fromWeb(payload.body as never), res);
    }

    private async requireInternalOps(req: Request, res: Response): Promise<void> {
        const auth = await this.jwtAuthenticator.authenticate(req.header('authorization'), res.locals.correlationId);
        if (auth.role !== 'internal') {
            throw new ApiError(
                'Hanya BNPB Internal Ops yang boleh memeriksa pesan yang gagal diproses',
                403,
                'forbidden'
            );
        }
    }
}
