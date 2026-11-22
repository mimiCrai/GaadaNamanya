import { z } from 'zod';

// Message published by the Client API on `field-reports` (D-38); same contract as the Aggregator's
export const fieldReportMessageSchema = z
    .object({
        v: z.literal(1),
        report: z
            .object({
                report_id: z.string().uuid(),
                hazard_type: z.enum(['SEISMIC', 'VOLCANIC', 'WILDFIRE', 'COASTAL', 'OTHER']),
                latitude: z.number().min(-90).max(90),
                longitude: z.number().min(-180).max(180),
                description: z.string().min(1).max(2000),
                severity_estimate: z.enum(['NORMAL', 'WASPADA', 'SIAGA', 'AWAS']),
                reported_at: z.string().datetime({ offset: true }),
            })
            .strict(),
        reporter: z.object({ sub: z.string().min(1).max(256), role: z.enum(['lapangan', 'internal']) }).strict(),
        accepted_at: z.string().datetime({ offset: true }),
    })
    .strict();

export type FieldReportMessage = z.infer<typeof fieldReportMessageSchema>;
