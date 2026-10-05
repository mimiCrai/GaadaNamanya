import { z } from 'zod';

export const BMKG_API_KEY_PATTERN = /^bmkg_[A-Za-z0-9]{1,32}_[0-9a-f]{32}$/;

const DELAY_DEFAULT_MIN_MS = 50;
const DELAY_DEFAULT_MAX_MS = 150;
const EVENT_INTERVAL_MAX_MS = 10_000;

const commaList = z
    .string()
    .transform((value) =>
        value
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
    )
    .pipe(
        z
            .array(z.string().regex(BMKG_API_KEY_PATTERN, 'each key must match bmkg_<keyid>_<32 hex>'))
            .min(1, 'at least one key is required')
    );

const optionalString = z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

const envSchema = z
    .object({
        PORT: z.coerce.number().int().positive().default(8081),
        NODE_ENV: z.enum(['local', 'staging', 'production', 'test']).default('local'),
        LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

        BMKG_API_KEYS: commaList,

        BMKG_DELAY_MIN_MS: z.coerce.number().int().min(0).default(100),
        BMKG_DELAY_MAX_MS: z.coerce.number().int().min(0).default(100),
        BMKG_EVENT_INTERVAL_MS: z.coerce.number().int().min(0).max(EVENT_INTERVAL_MAX_MS).default(5000),
        BMKG_WARNING_LAG_MS: z.coerce.number().int().min(0).default(0),
        RANDOM_SEED: optionalString,
    })
    .superRefine((env, ctx) => {
        if (env.BMKG_DELAY_MIN_MS > env.BMKG_DELAY_MAX_MS) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['BMKG_DELAY_MIN_MS'],
                message: 'BMKG_DELAY_MIN_MS must be <= BMKG_DELAY_MAX_MS',
            });
        }

        if (
            env.NODE_ENV !== 'test' &&
            (env.BMKG_DELAY_MIN_MS < DELAY_DEFAULT_MIN_MS || env.BMKG_DELAY_MAX_MS > DELAY_DEFAULT_MAX_MS)
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['BMKG_DELAY_MIN_MS'],
                message: `delay must satisfy ${DELAY_DEFAULT_MIN_MS} <= min <= max <= ${DELAY_DEFAULT_MAX_MS} (relaxed only when NODE_ENV=test)`,
            });
        }
    });

export interface AppConfig {
    port: number;
    nodeEnv: 'local' | 'staging' | 'production' | 'test';
    logLevel: string;
    apiKeys: string[];
    delayMinMs: number;
    delayMaxMs: number;
    eventIntervalMs: number;
    warningLagMs: number;
    randomSeed?: string;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
    const env = envSchema.parse(source);

    return {
        port: env.PORT,
        nodeEnv: env.NODE_ENV,
        logLevel: env.LOG_LEVEL,
        apiKeys: env.BMKG_API_KEYS,
        delayMinMs: env.BMKG_DELAY_MIN_MS,
        delayMaxMs: env.BMKG_DELAY_MAX_MS,
        eventIntervalMs: env.BMKG_EVENT_INTERVAL_MS,
        warningLagMs: env.BMKG_WARNING_LAG_MS,
        randomSeed: env.RANDOM_SEED,
    };
}
