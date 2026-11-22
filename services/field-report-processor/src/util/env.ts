import { z } from 'zod';

const envSchema = z.object({
    // Application
    PORT: z.coerce.number().int().positive().default(3000),
    SERVICE_NAME: z.string().default('field-report-processor'),
    NODE_ENV: z.enum(['local', 'staging', 'production', 'test']).default('local'),

    // Kafka (topic created by kafka-topic-init; never auto-created here)
    KAFKA_BROKERS: z
        .string()
        .min(1)
        .transform((value) =>
            value
                .split(',')
                .map((broker) => broker.trim())
                .filter(Boolean)
        ),
    KAFKA_CLIENT_ID: z.string().default('field-report-processor'),
    KAFKA_GROUP_ID: z.string().default('field-report-processor-group'),
    KAFKA_TOPIC: z.string().default('field-reports'),
    LAG_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),

    // Aggregator owns the Canonical Store (rule 5)
    BNPB_GATEWAY_BASE_URL: z.string().url().default('http://localhost:3003'),
    BNPB_GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
    BNPB_INTERNAL_API_KEY: z.string().min(32),

    // Processing policy (D-39)
    FIELD_REPORT_MAX_MESSAGE_BYTES: z.coerce.number().int().min(1_024).default(64 * 1024),
    FIELD_REPORT_MAX_PERMANENT_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
    FIELD_REPORT_BACKOFF_BASE_MS: z.coerce.number().int().min(10).default(500),
    FIELD_REPORT_BACKOFF_CAP_MS: z.coerce.number().int().min(100).default(30_000),
});

const env = envSchema.parse(process.env);

export default env;
