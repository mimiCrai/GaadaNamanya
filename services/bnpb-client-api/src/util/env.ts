import { z } from 'zod';

const envSchema = z.object({
    PORT: z.coerce.number().int().positive().default(3000),
    SERVICE_NAME: z.string().default('repo-template'),
    NODE_ENV: z.enum(['local', 'staging', 'production', 'test']).default('local'),

    BNPB_AUTH_PUBLIC_KEY_URL: z.string().url().default('http://localhost:3001/public-key'),
    BNPB_GATEWAY_BASE_URL: z.string().url().default('http://localhost:3003'),
    BNPB_GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    // Must match BNPB_AGGREGATOR_INTERNAL_API_KEY; never expose externally.
    BNPB_INTERNAL_API_KEY: z.string().min(32),
});

const env = envSchema.parse(process.env);

export default env;
