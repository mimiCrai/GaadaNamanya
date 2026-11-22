import { z } from 'zod';

// D-38: proposed minimal contract (team has not agreed one yet); reporter comes from the JWT, never the body
export const FIELD_REPORT_HAZARD_TYPES = ['SEISMIC', 'VOLCANIC', 'WILDFIRE', 'COASTAL', 'OTHER'] as const;
export const FIELD_REPORT_SEVERITIES = ['NORMAL', 'WASPADA', 'SIAGA', 'AWAS'] as const;
export const FIELD_REPORT_WRITER_ROLES = ['lapangan', 'internal'] as const;

export const fieldReportBodySchema = z
    .object({
        report_id: z.string().uuid(),
        hazard_type: z.enum(FIELD_REPORT_HAZARD_TYPES),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        description: z.string().min(1).max(2000),
        severity_estimate: z.enum(FIELD_REPORT_SEVERITIES),
        reported_at: z.string().datetime({ offset: true }),
    })
    .strict();

export type FieldReportBody = z.infer<typeof fieldReportBodySchema>;

export interface FieldReportMessage {
    v: 1;
    report: FieldReportBody;
    reporter: { sub: string; role: (typeof FIELD_REPORT_WRITER_ROLES)[number] };
    accepted_at: string;
}
