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
});

const env = envSchema.parse(process.env);

export default env;
