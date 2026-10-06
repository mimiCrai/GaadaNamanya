import pino, { DestinationStream, Logger } from 'pino';

export const SERVICE_NAME = 'pvmbg';

const REDACT_PATHS = [
    'authorization',
    '["x-bmkg-key"]',
    '["x-admin-token"]',
    'headers.authorization',
    'headers["x-bmkg-key"]',
    'headers["x-admin-token"]',
    'req.headers.authorization',
    'req.headers["x-bmkg-key"]',
    'req.headers["x-admin-token"]',
];

export interface LoggerOptions {
    level?: string;
    stream?: DestinationStream;
}

export function createLogger(options: LoggerOptions = {}): Logger {
    return pino(
        {
            level: options.level ?? 'info',
            base: { service: SERVICE_NAME },
            timestamp: pino.stdTimeFunctions.isoTime,
            formatters: {
                level: (label) => ({ level: label }),
            },
            redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
        },
        options.stream
    );
}
