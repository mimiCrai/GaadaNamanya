import { z } from 'zod';
import { generateKeyPairSync } from 'crypto';

const envSchema = z.object({
    // Application
    PORT: z.coerce.number().int().positive().default(3000),
    SERVICE_NAME: z.string().default('repo-template'),
    NODE_ENV: z.enum(['local', 'staging', 'production', 'test']).default('local'),

    // Authentication
    // RSA private key in PEM format. Literal `\\n` sequences are accepted for
    // deployment environments that cannot store multiline values (including
    // values double-escaped by a configuration system).
    JWT_PRIVATE_KEY: z.string().min(1).optional(),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(60),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604800),

    // PostgreSQL
    DATABASE_URL: z.string().url(),
});

const parsedEnv = envSchema.parse(process.env);

if (!parsedEnv.JWT_PRIVATE_KEY && parsedEnv.NODE_ENV !== 'test') {
    throw new Error('JWT_PRIVATE_KEY is required outside the test environment');
}

// E2E tests need a stable key only for the lifetime of this one Auth process.
// Production and local environments must always provide their own private key.
const testPrivateKey = !parsedEnv.JWT_PRIVATE_KEY
    ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    : undefined;

const env = {
    ...parsedEnv,
    JWT_PRIVATE_KEY: parsedEnv.JWT_PRIVATE_KEY ?? testPrivateKey!,
};

export default env;
