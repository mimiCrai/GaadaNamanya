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

        // Satellite feed (P4). Off by default so dev/e2e stacks never open a stream by accident (rule 2).
        SATELLITE_INGEST_ENABLED: z
            .enum(['true', 'false'])
            .default('false')
            .transform((value) => value === 'true'),
        SATELLITE_BASE_URL: z.string().url().default('https://satellite.naufarrel.dev'),
        SATELLITE_TOKEN: z.string().default(''),
        SATELLITE_RAW_TOPIC: z.string().min(1).default('satellite.raw'),
        KAFKA_SATELLITE_TRANSACTIONAL_ID: z.string().min(1).default('bnpb-aggregator-satellite'),
        SATELLITE_CHECKPOINT_GROUP: z.string().min(1).default('bnpb-satellite-checkpoint'),
        SATELLITE_BATCH_MAX: z.coerce.number().int().min(1).max(5_000).default(200),
        SATELLITE_BATCH_LINGER_MS: z.coerce.number().int().min(0).max(5_000).default(100),
        SATELLITE_MAX_EVENT_BYTES: z.coerce
            .number()
            .int()
            .min(1_024)
            .max(16 * 1024 * 1024)
            .default(1024 * 1024),
        SATELLITE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
        SATELLITE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
        SATELLITE_SESSION_POLL_MS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),
        SATELLITE_BACKOFF_BASE_MS: z.coerce.number().int().min(50).default(1_000),
        SATELLITE_BACKOFF_CAP_MS: z.coerce.number().int().min(100).default(60_000),
        SATELLITE_429_BACKOFF_BASE_MS: z.coerce.number().int().min(50).default(2_000),
        SATELLITE_429_BACKOFF_CAP_MS: z.coerce.number().int().min(100).default(30_000),
        SATELLITE_AUTH_BACKOFF_MS: z.coerce.number().int().min(1_000).default(300_000),
    })
    .refine((values) => !values.SATELLITE_INGEST_ENABLED || values.SATELLITE_TOKEN.length > 0, {
        message: 'SATELLITE_TOKEN is required when SATELLITE_INGEST_ENABLED=true',
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
