import { z } from 'zod';

const envSchema = z
    .object({
        PORT: z.coerce.number().int().positive().default(3000),
        SERVICE_NAME: z.string().default('repo-template'),
        NODE_ENV: z.enum(['local', 'staging', 'production', 'test']).default('local'),

        BNPB_AUTH_PUBLIC_KEY_URL: z.string().url().default('http://localhost:3001/public-key'),
        BNPB_GATEWAY_BASE_URL: z.string().url().default('http://localhost:3003'),
        BNPB_GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
        // Must match BNPB_AGGREGATOR_INTERNAL_API_KEY; never expose externally.
        BNPB_INTERNAL_API_KEY: z.string().min(32),
        ADMISSION_MAX_CONCURRENT_REQUESTS: z.coerce.number().int().positive().default(100),
        ADMISSION_RESERVED_LAPANGAN_REQUESTS: z.coerce.number().int().positive().default(20),
        ADMISSION_RETRY_AFTER_SECONDS: z.coerce.number().int().positive().default(1),

        // P3 #6 field reports (D-38): empty KAFKA_BROKERS disables the receiver (503)
        KAFKA_BROKERS: z
            .string()
            .default('')
            .transform((value) =>
                value
                    .split(',')
                    .map((broker) => broker.trim())
                    .filter(Boolean)
            ),
        KAFKA_CLIENT_ID: z.string().min(1).default('bnpb-client-api'),
        FIELD_REPORT_TOPIC: z.string().min(1).default('field-reports'),
        FIELD_REPORT_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
        FIELD_REPORT_MAX_BODY_BYTES: z.coerce.number().int().min(1_024).max(1024 * 1024).default(16 * 1024),
        FIELD_REPORT_RETRY_AFTER_SECONDS: z.coerce.number().int().positive().default(2),
    })
    .refine((value) => value.ADMISSION_RESERVED_LAPANGAN_REQUESTS < value.ADMISSION_MAX_CONCURRENT_REQUESTS, {
        message: 'Reserved Lapangan capacity must be less than the total concurrency limit',
        path: ['ADMISSION_RESERVED_LAPANGAN_REQUESTS'],
    });

const env = envSchema.parse(process.env);

export default env;
