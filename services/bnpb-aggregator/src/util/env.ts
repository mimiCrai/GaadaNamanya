import { z } from 'zod';

const envSchema = z
    .object({
        // Application
        PORT: z.coerce.number().int().positive().default(3000),
        SERVICE_NAME: z.string().default('repo-template'),
        NODE_ENV: z.enum(['local', 'staging', 'production', 'test']).default('local'),

        // MongoDB replica set or mongos router.
        DATABASE_URL: z.string().regex(/^mongodb(?:\+srv)?:\/\//),
        DATABASE_NAME: z.string().min(1).default('canonical_store'),
        STORAGE_READ_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
        MONGO_NODE_MAP: z
            .string()
            .default('{}')
            .transform((value) => z.record(z.string()).parse(JSON.parse(value))),
        BNPB_AUDIT_TOKEN: z.string().min(32),
        BACKGROUND_LEASE_MS: z.coerce.number().int().min(5_000).max(30_000).default(15_000),
        BACKGROUND_LEASE_RENEW_MS: z.coerce.number().int().min(250).max(5_000).default(2_000),
        LEASE_OPERATION_TIMEOUT_MS: z.coerce.number().int().min(500).max(5_000).default(3_000),

        // Kafka
        KAFKA_BROKERS: z
            .string()
            .min(1)
            .transform((value) =>
                value
                    .split(',')
                    .map((broker) => broker.trim())
                    .filter(Boolean)
            ),
        KAFKA_CLIENT_ID: z.string().default('bnpb-aggregator'),
        KAFKA_TOPIC: z.string().default('hazard-events'),
        KAFKA_TRANSACTIONAL_ID: z.string().min(1).default('bnpb-aggregator-outbox'),

        // Shared only with trusted BNPB services that read canonical hazards.
        BNPB_INTERNAL_API_KEY: z.string().min(32),

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

        // Safe decoding and unprocessed-message store (DLQ)
        PVMBG_MAX_BODY_BYTES: z.coerce
            .number()
            .int()
            .min(1_024)
            .max(64 * 1024 * 1024)
            .default(5 * 1024 * 1024),
        DECODE_MAX_DEPTH: z.coerce.number().int().min(4).max(1_000).default(64),
        DLQ_INLINE_MAX_BYTES: z.coerce
            .number()
            .int()
            .min(1_024)
            .max(8 * 1024 * 1024)
            .default(1024 * 1024),
        DLQ_INSPECT_MAX_BYTES: z.coerce
            .number()
            .int()
            .min(1_024)
            .max(32 * 1024 * 1024)
            .default(8 * 1024 * 1024),
        DLQ_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),
        DLQ_RETRY_BASE_MS: z.coerce.number().int().min(100).default(2_000),
        DLQ_RETRY_CAP_MS: z.coerce.number().int().min(1_000).default(300_000),
        DLQ_RETRY_INTERVAL_MS: z.coerce.number().int().min(100).default(2_000),
        DLQ_RETRY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
        DLQ_CLAIM_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
    })
    .refine(
        (values) => values.BACKGROUND_LEASE_RENEW_MS + values.LEASE_OPERATION_TIMEOUT_MS < values.BACKGROUND_LEASE_MS,
        {
            message: 'Lease duration must exceed renewal interval plus database operation timeout',
        }
    );

const env = envSchema.parse(process.env);

export default env;
