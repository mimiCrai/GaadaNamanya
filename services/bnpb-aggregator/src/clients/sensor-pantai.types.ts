import { z } from 'zod';

export const sensorStationSchema = z.object({
    station_id: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
    province: z.string().min(1).max(255),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
});

export const sensorObservationSchema = z
    .object({
        observation_id: z.string().min(1).max(255),
        station_id: z.string().min(1).max(255),
        observed_at: z.string().datetime({ offset: true }),
        sea_level_anomaly_m: z.number().finite(),
        wave_height_m: z.number().finite().nonnegative(),
        quality: z.string().min(1).max(64),
        critical: z.boolean(),
    })
    .passthrough();

export type SensorStation = z.infer<typeof sensorStationSchema>;
export type SensorObservation = z.infer<typeof sensorObservationSchema>;

export interface SensorPage {
    generatedAt: Date;
    items: unknown[];
    nextCursor: string | null;
}

export class SensorClientError extends Error {
    constructor(
        message: string,
        readonly status?: number,
        readonly rawBody?: string,
        readonly truncated = false,
        readonly retryAfterMs = 0
    ) {
        super(message);
    }
}
