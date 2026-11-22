import { z } from 'zod';

/**
 * Contract the Aggregator accepts from PVMBG (M1 v1 + additive v2 `confidence_level`).
 * Policy (docs/orang-c/SCHEMA_POLICY.md): additive fields are accepted and kept in `attributes`;
 * rename, type change and missing required fields are `schema_incompatible` until the mapping file adapts them.
 */
export const PVMBG_VOLCANIC_FIELDS = [
    'report_id',
    'volcano_id',
    'alert_level',
    'eruption_count_24h',
    'ash_column_height_m',
    'reported_at',
    'confidence_level',
] as const;

export type VolcanicField = (typeof PVMBG_VOLCANIC_FIELDS)[number];

export const ALERT_LEVELS = ['Normal', 'Waspada', 'Siaga', 'Awas'] as const;

// fields the HazardEvent mapping cannot do without; the mapping file may not make them optional
export const CORE_REQUIRED_FIELDS: readonly VolcanicField[] = ['report_id', 'volcano_id', 'alert_level', 'reported_at'];

export const DEFAULT_REQUIRED_FIELDS: readonly VolcanicField[] = [
    'report_id',
    'volcano_id',
    'alert_level',
    'eruption_count_24h',
    'ash_column_height_m',
    'reported_at',
];

const FIELD_SCHEMAS = {
    report_id: z.string().min(1).max(256),
    volcano_id: z.string().min(1).max(128),
    alert_level: z.enum(ALERT_LEVELS),
    eruption_count_24h: z.number().int().nonnegative(),
    ash_column_height_m: z.number().nonnegative(),
    reported_at: z.string().datetime({ offset: true }),
    // null = absent for validation only; the value itself is kept as received in attributes (4.0)
    confidence_level: z.number().min(0).max(1).nullable(),
} as const;

export function buildVolcanicReportSchema(required: readonly VolcanicField[]) {
    const shape = Object.fromEntries(
        PVMBG_VOLCANIC_FIELDS.map((field) => [
            field,
            required.includes(field) ? FIELD_SCHEMAS[field] : FIELD_SCHEMAS[field].optional(),
        ])
    ) as unknown as { [K in VolcanicField]: z.ZodTypeAny };
    return z.object(shape).passthrough();
}

export const volcanicReportSchema = buildVolcanicReportSchema(DEFAULT_REQUIRED_FIELDS);

export interface ValidVolcanicReport {
    report_id: string;
    volcano_id: string;
    alert_level: (typeof ALERT_LEVELS)[number];
    reported_at: string;
    [key: string]: unknown;
}
