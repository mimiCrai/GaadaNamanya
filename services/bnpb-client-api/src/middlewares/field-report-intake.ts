import bodyParser from 'body-parser';
import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../errors/api-error';
import { fieldReportAcceptSeconds, fieldReportResponsesTotal } from '../libs/metrics';
import { IJwtAuthenticator } from '../services/jwt-authenticator.service';
import { FIELD_REPORT_WRITER_ROLES } from '../types/field-report';
import env from '../util/env';

export const FIELD_REPORT_WRITE_FORBIDDEN =
    'Hanya Tim Lapangan dan BNPB Internal Ops yang boleh mengirim atau melihat laporan lapangan';

/**
 * POST /field-reports, mounted before the global 5 MB JSON parser: auth (401/403) → size limit (413) → JSON parse.
 * The body is never read for an unauthenticated caller.
 */
export function fieldReportIntake(authenticator: IJwtAuthenticator) {
    const parse = bodyParser.json({ limit: env.FIELD_REPORT_MAX_BODY_BYTES });
    return async (req: Request, res: Response, next: NextFunction) => {
        if (req.method !== 'POST' || (req.path !== '/' && req.path !== '')) return next();
        const startedAt = performance.now();
        res.once('finish', () => {
            const status = String(res.statusCode);
            fieldReportResponsesTotal.inc({ status });
            fieldReportAcceptSeconds.observe({ status }, (performance.now() - startedAt) / 1000);
        });
        try {
            const auth = await authenticator.authenticate(req.header('authorization'), res.locals.correlationId);
            if (!(FIELD_REPORT_WRITER_ROLES as readonly string[]).includes(auth.role)) {
                throw new ApiError(FIELD_REPORT_WRITE_FORBIDDEN, 403, 'forbidden');
            }
            res.locals.auth = auth;
        } catch (error) {
            return next(error);
        }
        parse(req, res, (error?: { type?: string }) => {
            if (error?.type === 'entity.too.large') {
                return next(
                    new ApiError(`Laporan melebihi batas ${env.FIELD_REPORT_MAX_BODY_BYTES} byte`, 413, 'payload_too_large')
                );
            }
            if (error) return next(new ApiError('Body JSON tidak valid', 400, 'invalid_body'));
            next();
        });
    };
}
