import { z } from 'zod';

const envSchema = z.object({
    // Application
    PORT: z.coerce.number().int().positive().default(3000),
    SERVICE_NAME: z.string().default('repo-template'),
    NODE_ENV: z.enum(['local', 'staging', 'production', 'test']).default('local'),

    // PostgreSQL
    DATABASE_URL: z.string().url(),

    // Kafka
    KAFKA_BROKERS: z
        .string()
        .min(1)
        .transform((value) => value.split(',').map((broker) => broker.trim()).filter(Boolean)),
    KAFKA_CLIENT_ID: z.string().default('bnpb-aggregator'),
    KAFKA_TOPIC: z.string().default('hazard-events'),

    // Source REST clients
    BMKG_BASE_URL: z.string().url(),
    BMKG_API_KEY: z.string().min(1),
    BMKG_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    PVMBG_BASE_URL: z.string().url(),
    PVMBG_TOKEN: z.string().min(1),
    PVMBG_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

    // Background jobs
    POLL_INTERVAL_MS: z.coerce.number().int().min(2_000).max(5_000).default(3_000),
    POLL_OVERLAP_MS: z.coerce.number().int().min(0).default(1_000),
    OUTBOX_RELAY_INTERVAL_MS: z.coerce.number().int().positive().default(250),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(100),
});

const env = envSchema.parse(process.env);

export default env;
