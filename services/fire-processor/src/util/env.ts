import { z } from 'zod';

const envSchema = z.object({
    PORT: z.coerce.number().int().positive().default(3000),
    SERVICE_NAME: z.string().default('fire-processor'),
    NODE_ENV: z.enum(['local', 'staging', 'production', 'test']).default('local'),

    KAFKA_BROKERS: z
        .string()
        .min(1)
        .transform((value) =>
            value
                .split(',')
                .map((broker) => broker.trim())
                .filter(Boolean)
        ),
    KAFKA_CLIENT_ID: z.string().default('fire-processor'),
    KAFKA_GROUP_ID: z.string().default('fire-processor-group'),
    SATELLITE_RAW_TOPIC: z.string().min(1).default('satellite.raw'),

    BNPB_GATEWAY_BASE_URL: z.string().url().default('http://localhost:3003'),
    BNPB_GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    BNPB_INTERNAL_API_KEY: z.string().min(32),

    FIRE_ALLOWED_LATENESS_MINUTES: z.coerce.number().int().min(0).max(7 * 24 * 60).default(120),

    FIRE_FLUSH_MAX_RECORDS: z.coerce.number().int().min(1).max(100_000).default(1_000),
    FIRE_SNAPSHOT_EVERY_RECORDS: z.coerce.number().int().min(1).default(5_000),
    FIRE_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().min(100).default(30_000),
    FIRE_BATCH_MAX_OPS: z.coerce.number().int().min(1).max(500).default(500),
    FIRE_BATCH_MAX_BYTES: z.coerce.number().int().min(16 * 1024).max(4 * 1024 * 1024).default(3 * 1024 * 1024),
    FIRE_BACKOFF_BASE_MS: z.coerce.number().int().min(1).default(500),
    FIRE_BACKOFF_CAP_MS: z.coerce.number().int().min(1).default(30_000),
});

const env = envSchema.parse(process.env);

export default env;
