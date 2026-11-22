import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost, request, requestParam, response } from 'inversify-express-utils';
import { z } from 'zod';
import { TYPES } from '../constants/types';
import { ApiError } from '../errors/api-error';
import { FIELD_REPORT_WRITE_FORBIDDEN } from '../middlewares/field-report-intake';
import { IFieldReportGateway } from '../services/field-report-gateway.service';
import { IFieldReportPublisher, PublishUnavailableError } from '../services/field-report-publisher.service';
import { IJwtAuthenticator } from '../services/jwt-authenticator.service';
import { AuthContext } from '../types/auth';
import { FIELD_REPORT_WRITER_ROLES, fieldReportBodySchema, FieldReportMessage } from '../types/field-report';
import env from '../util/env';

/**
 * P3 #6 (D-38): 202 only after Kafka acknowledged the report (acks=-1); no downstream call on this path.
 * A resend with the same report_id is published again and deduplicated by the consumer (first write wins).
 */
@controller('/field-reports')
export class FieldReportController {
    constructor(
        @inject(TYPES.FieldReportPublisher) private readonly publisher: IFieldReportPublisher,
        @inject(TYPES.FieldReportGateway) private readonly gateway: IFieldReportGateway,
        @inject(TYPES.JwtAuthenticator) private readonly jwtAuthenticator: IJwtAuthenticator
    ) {}

    // auth and size limit already ran in fieldReportIntake
    @httpPost('/')
    async submit(@request() req: Request, @response() res: Response) {
        const auth = res.locals.auth as AuthContext;
        const parsed = fieldReportBodySchema.safeParse(req.body);
        if (!parsed.success) {
            const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`);
            throw new ApiError(`Laporan tidak valid (${detail.slice(0, 5).join('; ')})`, 400, 'invalid_body');
        }
        const message: FieldReportMessage = {
            v: 1,
            report: parsed.data,
            reporter: { sub: auth.sub, role: auth.role as FieldReportMessage['reporter']['role'] },
            accepted_at: new Date().toISOString(),
        };
        try {
            await this.publisher.publish(message, res.locals.correlationId);
        } catch (error) {
            if (!(error instanceof PublishUnavailableError)) throw error;
            res.set('Retry-After', String(env.FIELD_REPORT_RETRY_AFTER_SECONDS));
            throw new ApiError('Laporan belum diterima; kirim ulang dengan report_id yang sama', 503, 'service_unavailable');
        }
        return res
            .status(202)
            .location(`/field-reports/${parsed.data.report_id}`)
            .json({ report_id: parsed.data.report_id, status: 'accepted', accepted_at: message.accepted_at });
    }

    @httpGet('/:reportId')
    async status(@requestParam('reportId') reportId: string, @request() req: Request, @response() res: Response) {
        const auth = await this.jwtAuthenticator.authenticate(req.header('authorization'), res.locals.correlationId);
        if (!(FIELD_REPORT_WRITER_ROLES as readonly string[]).includes(auth.role)) {
            throw new ApiError(FIELD_REPORT_WRITE_FORBIDDEN, 403, 'forbidden');
        }
        const stored = z.string().uuid().safeParse(reportId).success
            ? await this.gateway.find(reportId, res.locals.correlationId)
            : null;
        if (!stored) throw new ApiError('Laporan belum diproses atau tidak dikenal', 404, 'not_found');
        return res.json(stored);
    }
}
