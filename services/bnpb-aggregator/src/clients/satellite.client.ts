import { injectable } from 'inversify';
import { logger } from '../libs/logger';
import { HttpStatusError } from '../libs/processing-error';
import env from '../util/env';

export const SATELLITE_STREAM_ENDPOINT = 'GET /v1/stream';
const ALLOWED_PATHS = new Set(['/v1/session', '/v1/stream']);
const ERROR_BODY_MAX_BYTES = 16 * 1024;

export class SatelliteHttpError extends HttpStatusError {
    constructor(
        status: number,
        readonly code: string | null,
        readonly detail: string | null
    ) {
        super('SATELIT', status);
        this.name = 'SatelliteHttpError';
        if (code) this.message = `${this.message} (${code}${detail ? `: ${detail}` : ''})`;
    }
}

export interface SatelliteSession {
    profile: string | null;
    group: string | null;
    speed: number | null;
    latestOffset: number | null;
    virtualNow: string | null;
}

export interface StreamRequestOptions {
    signal: AbortSignal;
    correlationId: string;
}

export interface ISatelliteFeedClient {
    openStream(from: number, options: StreamRequestOptions): Promise<AsyncIterable<Uint8Array>>;
    getSession(options: StreamRequestOptions): Promise<SatelliteSession>;
}

export function satelliteUrl(pathname: string, query: Record<string, string> = {}, base = env.SATELLITE_BASE_URL): URL {
    if (!ALLOWED_PATHS.has(pathname)) throw new Error(`Satellite path ${pathname} is not allowed`);
    const url = new URL(pathname, base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
}

@injectable()
export class SatelliteFeedClient implements ISatelliteFeedClient {
    async openStream(from: number, options: StreamRequestOptions): Promise<AsyncIterable<Uint8Array>> {
        if (!Number.isSafeInteger(from) || from < 0) throw new RangeError(`invalid from=${from}`);
        const url = satelliteUrl('/v1/stream', { from: String(from) });
        const response = await this.request(url, '/v1/stream', options, { Accept: 'text/event-stream' });
        if (!response.body) throw new SatelliteHttpError(response.status, 'empty_body', 'stream tanpa body');
        return response.body as unknown as AsyncIterable<Uint8Array>;
    }

    async getSession(options: StreamRequestOptions): Promise<SatelliteSession> {
        const response = await this.request(satelliteUrl('/v1/session'), '/v1/session', options, {
            Accept: 'application/json',
        });
        const body = (await response.json()) as Record<string, unknown>;
        return {
            profile: typeof body.profile === 'string' ? body.profile : null,
            group: typeof body.group === 'string' ? body.group : null,
            speed: typeof body.speed === 'number' ? body.speed : null,
            latestOffset: Number.isSafeInteger(body.latest_offset) ? (body.latest_offset as number) : null,
            virtualNow: typeof body.virtual_now === 'string' ? body.virtual_now : null,
        };
    }

    private async request(
        url: URL,
        path: string,
        options: StreamRequestOptions,
        headers: Record<string, string>
    ): Promise<Response> {
        const controller = new AbortController();
        const forward = () => controller.abort(options.signal.reason);
        if (options.signal.aborted) forward();
        else options.signal.addEventListener('abort', forward, { once: true });
        const timer = setTimeout(
            () => controller.abort(new DOMException('connect timeout', 'TimeoutError')),
            env.SATELLITE_CONNECT_TIMEOUT_MS
        );
        const startedAt = Date.now();
        let statusCode: number | undefined;
        try {
            const response = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${env.SATELLITE_TOKEN}`,
                    'User-Agent': 'bnpb-aggregator-satellite/1.0',
                    'X-Correlation-ID': options.correlationId,
                    ...headers,
                },
                signal: controller.signal,
            });
            statusCode = response.status;
            if (!response.ok) throw await toHttpError(response);
            return response;
        } finally {
            clearTimeout(timer);
            logger.info(
                {
                    source: 'SATELIT',
                    path,
                    statusCode,
                    latencyMs: Date.now() - startedAt,
                    correlationId: options.correlationId,
                },
                'Completed outbound source request'
            );
        }
    }
}

async function toHttpError(response: Response): Promise<SatelliteHttpError> {
    let text = '';
    try {
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (reader && size < ERROR_BODY_MAX_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.byteLength;
        }
        await reader?.cancel().catch(() => undefined);
        text = Buffer.concat(chunks).subarray(0, ERROR_BODY_MAX_BYTES).toString('utf8');
    } catch {
        // status code is enough
    }
    try {
        const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
        const code = typeof parsed.error?.code === 'string' ? parsed.error.code : null;
        const message = typeof parsed.error?.message === 'string' ? parsed.error.message : null;
        return new SatelliteHttpError(response.status, code, message);
    } catch {
        return new SatelliteHttpError(response.status, null, null);
    }
}
