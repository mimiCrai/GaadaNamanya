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

        SENSOR_PANTAI_ENABLED: z
            .enum(['true', 'false'])
            .default('false')
            .transform((value) => value === 'true'),
        SENSOR_PANTAI_BASE_URL: z.string().url().default('http://sensor-pantai:8080'),
        SENSOR_PANTAI_TOKEN: z.string().default(''),
        SENSOR_PANTAI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(5000).default(1000),
        SENSOR_PANTAI_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(5000).default(500),
        SENSOR_PANTAI_PAGE_SIZE: z.coerce.number().int().min(1).max(1000).default(200),
        SENSOR_PANTAI_MAX_PAGES_PER_POLL: z.coerce.number().int().min(1).max(20).default(4),
        SENSOR_PANTAI_MAX_RESPONSE_BYTES: z.coerce
            .number()
            .int()
            .min(1024)
            .max(4 * 1024 * 1024)
            .default(1024 * 1024),
        SENSOR_PANTAI_MAX_RECORD_BYTES: z.coerce.number().int().min(512).max(32768).default(8192),
        SENSOR_PANTAI_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(10).default(3),
        SENSOR_PANTAI_COOLDOWN_MS: z.coerce.number().int().min(500).max(60000).default(2000),
        SENSOR_PANTAI_STALE_AFTER_MS: z.coerce.number().int().min(1000).default(10000),
        SENSOR_PANTAI_MAX_SOURCE_LAG_MS: z.coerce.number().int().min(1000).default(120000),
        SENSOR_PANTAI_MAX_FUTURE_MS: z.coerce.number().int().min(0).default(30000),

        // Background jobs
        POLL_INTERVAL_MS: z.coerce.number().int().min(2_000).max(5_000).default(3_000),
        POLL_OVERLAP_MS: z.coerce.number().int().min(0).default(1_000),
        OUTBOX_RELAY_INTERVAL_MS: z.coerce.number().int().positive().default(250),
        OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(100),
    })
    .refine((values) => !values.SENSOR_PANTAI_ENABLED || values.SENSOR_PANTAI_TOKEN.length > 0, {
        message: 'Enabled Sensor Pantai requires a nonempty SENSOR_PANTAI_TOKEN',
    })
    .refine(
        (values) => values.BACKGROUND_LEASE_RENEW_MS + values.LEASE_OPERATION_TIMEOUT_MS < values.BACKGROUND_LEASE_MS,
        {
            message: 'Lease duration must exceed renewal interval plus database operation timeout',
        }
    );

const env = envSchema.parse(process.env);

export default env;
