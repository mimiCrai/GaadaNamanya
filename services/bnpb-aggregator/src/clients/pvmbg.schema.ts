import { z } from 'zod';

/**
 * Contract the Aggregator accepts from PVMBG (M1 v1 + additive v2 `confidence_level`).
 * Policy: new *additional* fields are accepted automatically and kept in `attributes` (passthrough).
 * Renamed fields, changed types, and missing required fields are `schema_incompatible` and parked.
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

export const volcanicReportSchema = z
    .object({
        report_id: z.string().min(1).max(256),
        volcano_id: z.string().min(1).max(128),
        alert_level: z.enum(['Normal', 'Waspada', 'Siaga', 'Awas']),
        eruption_count_24h: z.number().int().nonnegative(),
        ash_column_height_m: z.number().nonnegative(),
        reported_at: z.string().datetime({ offset: true }),
        confidence_level: z.number().min(0).max(1).optional(),
    })
    .passthrough();

export type ValidVolcanicReport = z.infer<typeof volcanicReportSchema>;
