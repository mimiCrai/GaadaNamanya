import { z } from 'zod';

const isoDateTime = z
    .string()
    .datetime({ offset: true })
    .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a real date-time');

export const ALERT_LEVELS = ['Normal', 'Waspada', 'Siaga', 'Awas'] as const;

export const VolcanicReportV1Schema = z
    .object({
        report_id: z.string().min(1),
        volcano_id: z.string().min(1),
        alert_level: z.enum(ALERT_LEVELS),
        eruption_count_24h: z.number().int().nonnegative(),
        ash_column_height_m: z.number().nonnegative(),
        reported_at: isoDateTime,
    })
    .strict();

// v2 is additive: confidence_level exists only on records created while v2 was active
export const VolcanicReportV2Schema = VolcanicReportV1Schema.extend({
    confidence_level: z.number().min(0).max(1),
}).strict();

export type AlertLevel = (typeof ALERT_LEVELS)[number];
export type SchemaVersion = 1 | 2;
export type VolcanicReport = z.infer<typeof VolcanicReportV1Schema> & { confidence_level?: number };

export const ListQuerySchema = z.object({
    since: isoDateTime.optional(),
    limit: z
        .string()
        .regex(/^\d+$/, 'limit must be an integer')
        .transform(Number)
        .pipe(z.number().int().min(1).max(1000))
        .optional()
        .default('500'),
});

export const SchemaVersionBodySchema = z
    .object({
        version: z.union([z.literal(1), z.literal(2)]),
    })
    .strict();

export const OUTAGE_MODES = ['hang', 'error'] as const;
export type OutageMode = (typeof OUTAGE_MODES)[number];

export const OutageBodySchema = z
    .object({
        enabled: z.boolean(),
        mode: z.enum(OUTAGE_MODES).default('error'),
    })
    .strict();
