import { z } from 'zod';
import { generateKeyPairSync } from 'crypto';

const envSchema = z.object({
    PORT: z.coerce.number().int().positive().default(3000),
    SERVICE_NAME: z.string().default('repo-template'),
    NODE_ENV: z.enum(['local', 'staging', 'production', 'test']).default('local'),

    // Accepts literal or double-escaped PEM line breaks from environment files.
    JWT_PRIVATE_KEY: z.string().min(1).optional(),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(60),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(604800),

    DATABASE_URL: z.string().url(),
});

const parsedEnv = envSchema.parse(process.env);

if (!parsedEnv.JWT_PRIVATE_KEY && parsedEnv.NODE_ENV !== 'test') {
    throw new Error('JWT_PRIVATE_KEY is required outside the test environment');
}

// Only tests may generate an ephemeral signing key.
const testPrivateKey = !parsedEnv.JWT_PRIVATE_KEY
    ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    : undefined;

const env = {
    ...parsedEnv,
    JWT_PRIVATE_KEY: parsedEnv.JWT_PRIVATE_KEY ?? testPrivateKey!,
};

export default env;
