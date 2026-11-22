import { z } from 'zod';

export const hazardEventMessageSchema = z.object({
    eventId: z.string().uuid(),
    // hazard.deleted (P4): a merged or vanished WILDFIRE removed from the Canonical Store
    eventType: z.enum(['hazard.created', 'hazard.updated', 'hazard.deleted']),
    correlationId: z.string().uuid(),
    hazard: z.object({
        hazardId: z.string().uuid(),
        source: z.enum(['BMKG', 'PVMBG', 'SATELIT', 'SENSOR_PANTAI']),
        sourceRefId: z.string().min(1),
        hazardType: z.enum(['SEISMIC', 'VOLCANIC', 'WILDFIRE', 'COASTAL']),
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
