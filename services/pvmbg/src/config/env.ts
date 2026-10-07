import { z } from 'zod';

export const PVMBG_TOKEN_PATTERN = /^pvmbg\.[A-Za-z0-9-]{1,32}\.[0-9a-f]{32}$/;

const DELAY_MAX_MS = 60_000;
const DELAY_DEFAULT_MIN_MS = 500;
const DELAY_DEFAULT_MAX_MS = 3_000;
const REPORT_INTERVAL_MAX_MS = 10_000;
const generationProbability = z.coerce.number().min(0).max(1);

const tokenList = z
    .string()
    .transform((value) =>
        value
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
    )
    .pipe(
        z
            .array(z.string().regex(PVMBG_TOKEN_PATTERN, 'each token must match pvmbg.<client_id>.<32 hex>'))
            .min(1, 'at least one token is required')
    );

const optionalString = z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

const delayMs = z.coerce.number().int().min(0).max(DELAY_MAX_MS);

const envSchema = z
    .object({
        PORT: z.coerce.number().int().positive().default(8082),
        NODE_ENV: z.enum(['local', 'staging', 'production', 'test']).default('local'),
        LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

        DATABASE_URL: z.string().url(),

        PVMBG_CLIENT_TOKENS: tokenList,

        PVMBG_DELAY_MIN_MS: delayMs.default(500),
        PVMBG_DELAY_MAX_MS: delayMs.default(3000),
        PVMBG_REPORT_INTERVAL_MS: z.coerce.number().int().min(0).max(REPORT_INTERVAL_MAX_MS).default(5000),
        PVMBG_REPORT_GENERATION_PROBABILITY: generationProbability.default(0.3),
        RANDOM_SEED: optionalString,
    })
    .superRefine((env, ctx) => {
        if (env.PVMBG_DELAY_MIN_MS > env.PVMBG_DELAY_MAX_MS) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['PVMBG_DELAY_MIN_MS'],
                message: 'PVMBG_DELAY_MIN_MS must be <= PVMBG_DELAY_MAX_MS',
            });
        }

        if (
            env.NODE_ENV !== 'test' &&
            (env.PVMBG_DELAY_MIN_MS < DELAY_DEFAULT_MIN_MS || env.PVMBG_DELAY_MAX_MS > DELAY_DEFAULT_MAX_MS)
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['PVMBG_DELAY_MIN_MS'],
                message: `delay must satisfy ${DELAY_DEFAULT_MIN_MS} <= min <= max <= ${DELAY_DEFAULT_MAX_MS} (relaxed only when NODE_ENV=test)`,
            });
        }
    });

export interface AppConfig {
    port: number;
    nodeEnv: 'local' | 'staging' | 'production' | 'test';
    logLevel: string;
    databaseUrl: string;
    clientTokens: string[];
    delayMinMs: number;
    delayMaxMs: number;
    reportIntervalMs: number;
    reportGenerationProbability: number;
    randomSeed?: string;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
    const env = envSchema.parse(source);

    return {
        port: env.PORT,
        nodeEnv: env.NODE_ENV,
        logLevel: env.LOG_LEVEL,
        databaseUrl: env.DATABASE_URL,
        clientTokens: env.PVMBG_CLIENT_TOKENS,
        delayMinMs: env.PVMBG_DELAY_MIN_MS,
        delayMaxMs: env.PVMBG_DELAY_MAX_MS,
        reportIntervalMs: env.PVMBG_REPORT_INTERVAL_MS,
        reportGenerationProbability: env.PVMBG_REPORT_GENERATION_PROBABILITY,
        randomSeed: env.RANDOM_SEED,
    };
}
