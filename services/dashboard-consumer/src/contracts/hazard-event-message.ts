import { z } from 'zod';

export const hazardEventMessageSchema = z.object({
    eventId: z.string().uuid(),
    eventType: z.enum(['hazard.created', 'hazard.updated']),
    correlationId: z.string().uuid(),
    hazard: z.object({
        hazardId: z.string().uuid(),
        source: z.enum(['BMKG', 'PVMBG']),
        sourceRefId: z.string().min(1),
        hazardType: z.enum(['SEISMIC', 'VOLCANIC']),
        severity: z.enum(['NORMAL', 'WASPADA', 'SIAGA', 'AWAS']),
        areaName: z.string().min(1),
        latitude: z.number(),
        longitude: z.number(),
        occurredAt: z.string().datetime(),
        ingestedAt: z.string().datetime(),
        attributes: z.record(z.unknown()),
    }),
});

export type HazardEventMessage = z.infer<typeof hazardEventMessageSchema>;
