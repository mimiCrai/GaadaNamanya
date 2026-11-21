import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPut, requestParam, response } from 'inversify-express-utils';
import { z } from 'zod';
import { TYPES } from '../constants/types';
import { StoredFieldReport } from '../db/schema/field-reports';
import { fieldReportMessageSchema } from '../libs/field-report';
import { logger } from '../libs/logger';
import { IFieldReportRepository } from '../repositories/field-report.repository';

const reportIdSchema = z.string().uuid();
const putBodySchema = z
    .object({
        message: fieldReportMessageSchema,
        kafka: z
            .object({ topic: z.string().min(1), partition: z.number().int().min(0), offset: z.string().regex(/^\d+$/) })
            .strict()
            .nullable()
            .default(null),
    })
    .strict();
const listQuerySchema = z.object({
    after: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export function toFieldReportItem(report: StoredFieldReport) {
    return {
        report_id: report.reportId,
        status: 'processed' as const,
        hazard_type: report.hazardType,
        latitude: report.latitude,
        longitude: report.longitude,
        description: report.description,
        severity_estimate: report.severityEstimate,
        reported_at: report.reportedAt.toISOString(),
        reporter: report.reporter,
        accepted_at: report.acceptedAt.toISOString(),
        processed_at: report.processedAt.toISOString(),
        content_sha256: report.contentSha256,
        deliveries: report.deliveries,
        kafka: report.kafka,
    };
}

// D-39: field-report-processor writes here (rule 5); no lease, any replica behind the LB serves it
@controller('/internal/field-reports', TYPES.InternalAuthMiddleware)
export class FieldReportController {
    constructor(@inject(TYPES.IFieldReportRepository) private readonly reports: IFieldReportRepository) {}

    @httpPut('/:reportId')
    async put(@requestParam('reportId') reportId: string, req: Request, res: Response) {
        const parsed = putBodySchema.safeParse(req.body ?? {});
        if (
            !reportIdSchema.safeParse(reportId).success ||
            !parsed.success ||
            parsed.data.message.report.report_id !== reportId
        ) {
            return res.status(400).json({ error: { code: 'bad_request', message: 'Invalid field report message' } });
        }
        const correlationId = String(res.getHeader('X-Correlation-ID'));
        const write = await this.reports.insertOnce(parsed.data.message, parsed.data.kafka, correlationId);
        logger.info(
            { reportId, result: write.result, deliveries: write.report.deliveries, kafka: parsed.data.kafka, correlationId },
            'Stored field report'
        );
        return res.json({
            result: write.result,
            incoming_sha256: write.incomingSha256,
            report: toFieldReportItem(write.report),
        });
    }

    @httpGet('/:reportId')
    async get(@requestParam('reportId') reportId: string, @response() res: Response) {
        const report = reportIdSchema.safeParse(reportId).success ? await this.reports.findById(reportId) : null;
        if (!report) return res.status(404).json({ error: { code: 'not_found', message: 'Field report not found' } });
        return res.json(toFieldReportItem(report));
    }

    @httpGet('/')
    async list(req: Request, res: Response) {
        const parsed = listQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return res.status(400).json({ error: { code: 'bad_request', message: 'Invalid after or limit' } });
        }
        const items = (await this.reports.list(parsed.data.after, parsed.data.limit)).map(toFieldReportItem);
        const nextAfter = items.length === parsed.data.limit ? items[items.length - 1].report_id : null;
        return res.json({ items, next_after: nextAfter });
    }
}
