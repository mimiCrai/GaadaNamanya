import { injectable } from 'inversify';
import { logger } from '../libs/logger';
import env from '../util/env';
import { getRecordsFromResponse, PollRequestOptions, VolcanicReport } from './source-client.types';

export interface IPvmbgClient {
    getVolcanicReports(options: PollRequestOptions): Promise<VolcanicReport[]>;
}

@injectable()
export class PvmbgClient implements IPvmbgClient {
    async getVolcanicReports(options: PollRequestOptions): Promise<VolcanicReport[]> {
        const url = new URL('/volcanic-reports', env.PVMBG_BASE_URL);
        if (options.since) {
            url.searchParams.set('since', options.since.toISOString());
        }

        const startedAt = Date.now();
        let statusCode: number | undefined;

        try {
            const response = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${env.PVMBG_TOKEN}`,
                    'X-Correlation-ID': options.correlationId,
                },
                signal: AbortSignal.timeout(env.PVMBG_REQUEST_TIMEOUT_MS),
            });
            statusCode = response.status;

            if (!response.ok) {
                throw new Error(`PVMBG request failed with HTTP ${response.status}`);
            }

            return getRecordsFromResponse<VolcanicReport>(await response.json());
        } finally {
            logger.info(
                {
                    source: 'PVMBG',
                    path: '/volcanic-reports',
                    statusCode,
                    latencyMs: Date.now() - startedAt,
                    correlationId: options.correlationId,
                },
                'Completed outbound source request'
            );
        }
    }
}
