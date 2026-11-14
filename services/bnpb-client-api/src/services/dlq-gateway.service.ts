import { injectable } from 'inversify';
import { ApiError } from '../errors/api-error';
import { logger } from '../libs/logger';
import env from '../util/env';

export interface DlqListQuery {
    source?: string;
    status?: string;
    limit?: string;
    cursor?: string;
}

export interface DlqRawPayload {
    body: ReadableStream<Uint8Array>;
    headers: Record<string, string>;
}

export interface IDlqGateway {
    list(query: DlqListQuery, correlationId: string): Promise<unknown>;
    detail(messageId: string, correlationId: string): Promise<unknown>;
    raw(messageId: string, correlationId: string): Promise<DlqRawPayload>;
}

const RAW_HEADERS = ['content-type', 'content-length', 'x-payload-sha256', 'x-original-content-type'];

/** Proxies Internal Ops DLQ inspection to the Aggregator with the internal service key. */
@injectable()
export class DlqGateway implements IDlqGateway {
    async list(query: DlqListQuery, correlationId: string): Promise<unknown> {
        const response = await this.request('/internal/dlq', correlationId, query);
        return response.json();
    }

    async detail(messageId: string, correlationId: string): Promise<unknown> {
        const response = await this.request(`/internal/dlq/${encodeURIComponent(messageId)}`, correlationId);
        return response.json();
    }

    async raw(messageId: string, correlationId: string): Promise<DlqRawPayload> {
        const response = await this.request(`/internal/dlq/${encodeURIComponent(messageId)}/raw`, correlationId);
        const headers: Record<string, string> = {};
        for (const name of RAW_HEADERS) {
            const value = response.headers.get(name);
            if (value) headers[name] = value;
        }
        if (!response.body) throw new ApiError('BNPB Gateway returned an invalid response', 502);
        return { body: response.body, headers };
    }

    private async request(path: string, correlationId: string, query: object = {}): Promise<Response> {
        const url = new URL(path, `${env.BNPB_GATEWAY_BASE_URL}/`);
        for (const [name, value] of Object.entries(query)) {
            if (typeof value === 'string') url.searchParams.set(name, value);
        }
        const startedAt = Date.now();
        let response: Response;
        try {
            response = await fetch(url, {
                headers: { 'X-BNPB-Internal-Key': env.BNPB_INTERNAL_API_KEY, 'X-Correlation-ID': correlationId },
                signal: AbortSignal.timeout(env.BNPB_GATEWAY_TIMEOUT_MS),
            });
        } catch (error) {
            const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
            logger.error(
                { target: 'bnpb-aggregator', path, correlationId, latencyMs: Date.now() - startedAt, timedOut },
                'Outgoing request failed'
            );
            throw timedOut
                ? new ApiError('BNPB Gateway did not respond in time', 504)
                : new ApiError('BNPB Gateway is unavailable', 502);
        }
        logger.info(
            {
                target: 'bnpb-aggregator',
                path,
                status: response.status,
                correlationId,
                latencyMs: Date.now() - startedAt,
            },
            'Outgoing request completed'
        );
        if (response.ok) return response;

        const body = (await response.json().catch(() => undefined)) as
            { error?: { code?: unknown; message?: unknown } } | undefined;
        const message = typeof body?.error?.message === 'string' ? body.error.message : 'Request failed';
        const code = typeof body?.error?.code === 'string' ? body.error.code : undefined;
        if (response.status === 400) throw new ApiError(message, 400, code ?? 'bad_request');
        if (response.status === 404) throw new ApiError('Unprocessed message not found', 404, 'not_found');
        if (response.status === 503) throw new ApiError('Unprocessed message storage is temporarily unavailable', 503);
        throw new ApiError('BNPB Gateway is unavailable', 502);
    }
}
