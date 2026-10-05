import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpPost, request, response } from 'inversify-express-utils';
import { ZodType, ZodTypeDef } from 'zod';
import { TYPES } from '../constants/types';
import { sendError } from '../libs/http-error';
import { OutageService } from '../services/outage.service';
import { SchemaService } from '../services/schema.service';
import { OutageBodySchema, SchemaVersionBodySchema } from '../types/contract';

// operator controls, protected by the same client token as the data endpoint
@controller('/admin', TYPES.DataAuthMiddleware)
export class AdminController {
    constructor(
        @inject(TYPES.SchemaService) private readonly schema: SchemaService,
        @inject(TYPES.OutageService) private readonly outage: OutageService
    ) {}

    @httpPost('/schema-version')
    setSchemaVersion(@request() req: Request, @response() res: Response) {
        const body = parseBody(SchemaVersionBodySchema, req, res);
        if (!body) return;
        return res.json(this.schema.set(body.version));
    }

    @httpPost('/outage')
    setOutage(@request() req: Request, @response() res: Response) {
        const body = parseBody(OutageBodySchema, req, res);
        if (!body) return;
        return res.json(this.outage.set(body.enabled, body.mode));
    }
}

function parseBody<T>(schema: ZodType<T, ZodTypeDef, unknown>, req: Request, res: Response): T | undefined {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
        const detail = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
            .join('; ');
        sendError(res, 400, 'invalid_body', `Invalid request body (${detail})`);
        return undefined;
    }
    return parsed.data;
}
