import { z } from 'zod';

const isoDateTime = z
    .string()
    .datetime({ offset: true })
    .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a real date-time');

export const SeismicEventSchema = z
    .object({
        event_id: z.string().min(1),
        magnitude: z
            .number()
            .refine((value) => Math.round(value * 10) / 10 === value, 'magnitude must have at most 1 decimal'),
        depth_km: z.number().nonnegative(),
        epicenter_lat: z.number().min(-11.5).max(6.5),
        epicenter_lon: z.number().min(94.5).max(141.5),
        region_name: z.string().min(1),
        occurred_at: isoDateTime,
        potential_tsunami: z.boolean(),
    })
    .strict();

export const THREAT_LEVELS = ['Waspada', 'Siaga', 'Awas'] as const;

export const TsunamiWarningSchema = z
    .object({
        warning_id: z.string().min(1),
        related_event_id: z.string().min(1),
        threat_level: z.enum(THREAT_LEVELS),
        affected_zones: z.array(z.string().min(1)).min(1),
        estimated_arrival: isoDateTime,
        issued_at: isoDateTime,
    })
    .strict();

export type SeismicEvent = z.infer<typeof SeismicEventSchema>;
export type TsunamiWarning = z.infer<typeof TsunamiWarningSchema>;
export type ThreatLevel = (typeof THREAT_LEVELS)[number];

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
