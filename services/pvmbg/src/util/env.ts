import { z } from 'zod';

const envSchema = z.object({
    // Application
    PORT: z.coerce.number().int().positive().default(3000),
    SERVICE_NAME: z.string().default('repo-template'),
    NODE_ENV: z.enum(['local', 'staging', 'production', 'test']).default('local'),

    // PostgreSQL
    DATABASE_URL: z.string().url(),

});

const env = envSchema.parse(process.env);

export default env;
