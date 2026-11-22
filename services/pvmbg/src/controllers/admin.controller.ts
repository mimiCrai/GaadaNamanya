import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost, request, response } from 'inversify-express-utils';
import { ZodType, ZodTypeDef } from 'zod';
import { TYPES } from '../constants/types';
import { sendError } from '../libs/http-error';
import { MalformedService } from '../services/malformed.service';
import { OutageService } from '../services/outage.service';
import { SchemaService } from '../services/schema.service';
import { MalformedBodySchema, OutageBodySchema, SchemaChangeBodySchema } from '../types/contract';

// operator controls, protected by the same client token as the data endpoint
@controller('/admin', TYPES.DataAuthMiddleware)
export class AdminController {
    constructor(
        @inject(TYPES.SchemaService) private readonly schema: SchemaService,
        @inject(TYPES.OutageService) private readonly outage: OutageService,
        @inject(TYPES.MalformedService) private readonly malformed: MalformedService
    ) {}

    @httpPost('/schema-version')
    setSchemaVersion(@request() req: Request, @response() res: Response) {
        const body = parseBody(SchemaChangeBodySchema, req, res);
        if (!body) return;
        return res.json('version' in body ? this.schema.set(body.version) : this.schema.setMode(body.mode));
    }

    @httpPost('/outage')
    setOutage(@request() req: Request, @response() res: Response) {
        const body = parseBody(OutageBodySchema, req, res);
        if (!body) return;
        return res.json(this.outage.set(body.enabled, body.mode));
    }

    // M2 (P3 #3): the next n data responses are malformed
    @httpPost('/malformed')
    queueMalformed(@request() req: Request, @response() res: Response) {
        const body = parseBody(MalformedBodySchema, req, res);
        if (!body) return;
        return res.json(this.malformed.enqueue(body.kind, body.count, body.bytes));
    }

    @httpGet('/malformed')
    malformedState(@response() res: Response) {
        return res.json(this.malformed.state());
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
