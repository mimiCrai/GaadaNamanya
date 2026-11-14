import { LeaseLostError } from '../db/schema/background-leases';

export const RETRYABLE_CATEGORIES = [
    'timeout',
    'connection',
    'upstream_unavailable',
    'store_unavailable',
    'unexpected',
] as const;

export const PERMANENT_CATEGORIES = [
    'malformed_json',
    'invalid_utf8',
    'nesting_too_deep',
    'payload_too_large',
    'schema_incompatible',
    'validation_failed',
    'handler_missing',
    'retry_exhausted',
] as const;

export type RetryableCategory = (typeof RETRYABLE_CATEGORIES)[number];
export type PermanentCategory = (typeof PERMANENT_CATEGORIES)[number];
export type ErrorCategory = RetryableCategory | PermanentCategory;

const RETRYABLE = new Set<string>(RETRYABLE_CATEGORIES);

export class ProcessingError extends Error {
    readonly retryable: boolean;

    constructor(
        readonly category: ErrorCategory,
        readonly detail: string,
        options?: { cause?: unknown }
    ) {
        super(`${category}: ${detail}`, options);
        this.name = 'ProcessingError';
        this.retryable = RETRYABLE.has(category);
    }

    get reason(): string {
        return this.message;
    }
}

export class HttpStatusError extends Error {
    constructor(
        readonly target: string,
        readonly status: number
    ) {
        super(`${target} request failed with HTTP ${status}`);
        this.name = 'HttpStatusError';
    }
}

const CONNECTION_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
]);

const MONGO_UNAVAILABLE_CODES = new Set([
    6, // HostUnreachable
    7, // HostNotFound
    50, // MaxTimeMSExpired
    89, // NetworkTimeout
    91, // ShutdownInProgress
    133, // FailedToSatisfyReadPreference
    189, // PrimarySteppedDown
    262, // ExceededTimeLimit
    10107, // NotWritablePrimary
    11600, // InterruptedAtShutdown
    11602, // InterruptedDueToReplStateChange
    13435, // NotPrimaryNoSecondaryOk
    13436, // NotPrimaryOrSecondary
]);

const MONGO_UNAVAILABLE_NAMES = new Set([
    'MongoServerSelectionError',
    'MongoNetworkError',
    'MongoNetworkTimeoutError',
    'MongoNotConnectedError',
    'MongoTopologyClosedError',
    'MongoOperationTimeoutError',
    'MongoWriteConcernError',
]);

interface ErrorLike {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
    hasErrorLabel?: (label: string) => boolean;
}

export function classifyError(error: unknown): ProcessingError {
    if (error instanceof ProcessingError) return error;
    if (error instanceof LeaseLostError) {
        throw new Error('LeaseLostError must be handled before classification', { cause: error });
    }
    const value = (error ?? {}) as ErrorLike;
    const name = typeof value.name === 'string' ? value.name : '';
    const message = typeof value.message === 'string' ? value.message : String(error);

    if (error instanceof HttpStatusError) {
        if (error.status >= 500 || error.status === 429 || error.status === 408) {
            return new ProcessingError('upstream_unavailable', `${error.target} membalas HTTP ${error.status}`, {
                cause: error,
            });
        }
        return new ProcessingError('validation_failed', `${error.target} menolak dengan HTTP ${error.status}`, {
            cause: error,
        });
    }
    if (name === 'AbortError' || name === 'TimeoutError') {
        return new ProcessingError('timeout', `batas waktu terlampaui (${message})`, { cause: error });
    }
    if (
        MONGO_UNAVAILABLE_NAMES.has(name) ||
        hasLabel(value, 'TransientTransactionError') ||
        hasLabel(value, 'RetryableWriteError')
    ) {
        return new ProcessingError(
            'store_unavailable',
            `penyimpanan tidak tersedia (${name || 'MongoError'}: ${message})`,
            {
                cause: error,
            }
        );
    }
    if (typeof value.code === 'number' && MONGO_UNAVAILABLE_CODES.has(value.code)) {
        return new ProcessingError(
            'store_unavailable',
            `unit penyimpanan tidak terjangkau (kode ${value.code}: ${message})`,
            {
                cause: error,
            }
        );
    }
    const code = connectionCode(value);
    if (code) {
        return new ProcessingError('connection', `koneksi gagal (${code})`, { cause: error });
    }
    return new ProcessingError('unexpected', `galat tak terduga: ${message}`.slice(0, 500), { cause: error });
}

function hasLabel(value: ErrorLike, label: string): boolean {
    try {
        return typeof value.hasErrorLabel === 'function' && value.hasErrorLabel(label);
    } catch {
        return false;
    }
}

function connectionCode(value: ErrorLike, depth = 0): string | undefined {
    if (depth > 3 || !value) return undefined;
    if (typeof value.code === 'string' && CONNECTION_CODES.has(value.code)) return value.code;
    if (value.message === 'fetch failed' && !value.cause) return 'fetch failed';
    return value.cause ? connectionCode(value.cause as ErrorLike, depth + 1) : undefined;
}
