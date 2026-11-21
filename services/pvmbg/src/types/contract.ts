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

// M2 (P3): incompatible schema modes; a record keeps the mode active when it was created
export const SCHEMA_MODES = ['v1', 'v2_confidence', 'rename_field', 'type_change', 'missing_required'] as const;
export type SchemaMode = (typeof SCHEMA_MODES)[number];

export const SchemaModeBodySchema = z.object({ mode: z.enum(SCHEMA_MODES) }).strict();

// either the M1 body {version} or the M2 body {mode}, never both
export const SchemaChangeBodySchema = z.union([SchemaVersionBodySchema, SchemaModeBodySchema]);

export const MALFORMED_KINDS = ['truncated', 'deep_nesting', 'invalid_utf8', 'oversized'] as const;
export type MalformedKind = (typeof MALFORMED_KINDS)[number];

export const MAX_OVERSIZED_BYTES = 64 * 1024 * 1024;

export const MalformedBodySchema = z
    .object({
        kind: z.enum(MALFORMED_KINDS),
        count: z.number().int().min(1).max(100).default(1),
        bytes: z.number().int().min(1024).max(MAX_OVERSIZED_BYTES).optional(),
    })
    .strict();

export type WireReport = Record<string, unknown>;
