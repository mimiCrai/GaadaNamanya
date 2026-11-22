import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HazardSeverity, HazardType } from '../db/schema/hazard-events';
import { ProcessingError } from './processing-error';

// D-38: proposed field report contract (not yet agreed by the team; recorded as an assumption)
export const FIELD_REPORT_HAZARD_TYPES = [...Object.values(HazardType), 'OTHER'] as const;

export const fieldReportSchema = z
    .object({
        report_id: z.string().uuid(),
        hazard_type: z.enum(FIELD_REPORT_HAZARD_TYPES as unknown as [string, ...string[]]),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        description: z.string().min(1).max(2000),
        severity_estimate: z.nativeEnum(HazardSeverity),
        reported_at: z.string().datetime({ offset: true }),
    })
    .strict();

export const fieldReportMessageSchema = z
    .object({
        v: z.literal(1),
        report: fieldReportSchema,
        reporter: z.object({ sub: z.string().min(1).max(256), role: z.enum(['lapangan', 'internal']) }).strict(),
        accepted_at: z.string().datetime({ offset: true }),
    })
    .strict();

export type FieldReport = z.infer<typeof fieldReportSchema>;
export type FieldReportMessage = z.infer<typeof fieldReportMessageSchema>;

// identity of the content: what the reporter sent (accepted_at excluded, so a resend is a duplicate)
export function fieldReportContentSha256(message: Pick<FieldReportMessage, 'report' | 'reporter'>): string {
    const { report, reporter } = message;
    const canonical = JSON.stringify([
        report.report_id,
        report.hazard_type,
        report.latitude,
        report.longitude,
        report.description,
        report.severity_estimate,
        new Date(report.reported_at).toISOString(),
        reporter.sub,
    ]);
    return createHash('sha256').update(canonical).digest('hex');
}

export function fieldReportConflictError(reportId: string, storedSha256: string, incomingSha256: string): ProcessingError {
    return new ProcessingError(
        'conflict',
        `report_id ${reportId} sudah ada dengan isi berbeda (sha256 ${storedSha256} vs ${incomingSha256})`
    );
}
