import { injectable } from 'inversify';
import { ApiError } from '../errors/api-error';
import { logger } from '../libs/logger';
import env from '../util/env';

export interface IFieldReportGateway {
    // null = not stored (yet)
    find(reportId: string, correlationId: string): Promise<Record<string, unknown> | null>;
}

/** Reads stored field reports from the Aggregator (rule 5: the Canonical Store belongs to the Aggregator). */
@injectable()
export class FieldReportGateway implements IFieldReportGateway {
    async find(reportId: string, correlationId: string): Promise<Record<string, unknown> | null> {
        const path = `/internal/field-reports/${encodeURIComponent(reportId)}`;
        const startedAt = Date.now();
        let response: Response;
        try {
            response = await fetch(new URL(path, `${env.BNPB_GATEWAY_BASE_URL}/`), {
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
            { target: 'bnpb-aggregator', path, status: response.status, correlationId, latencyMs: Date.now() - startedAt },
            'Outgoing request completed'
        );
        if (response.status === 404) return null;
        if (!response.ok) throw new ApiError('BNPB Gateway is unavailable', 502);
        return (await response.json()) as Record<string, unknown>;
    }
}
