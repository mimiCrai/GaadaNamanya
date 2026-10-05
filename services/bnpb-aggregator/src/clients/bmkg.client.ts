import { injectable } from 'inversify';
import { logger } from '../libs/logger';
import env from '../util/env';
import { getRecordsFromResponse, PollRequestOptions, SeismicEvent, TsunamiWarning } from './source-client.types';

export interface IBmkgClient {
    getSeismicEvents(options: PollRequestOptions): Promise<SeismicEvent[]>;
    getTsunamiWarnings(options: PollRequestOptions): Promise<TsunamiWarning[]>;
}

@injectable()
export class BmkgClient implements IBmkgClient {
    async getSeismicEvents(options: PollRequestOptions): Promise<SeismicEvent[]> {
        return this.getRecords<SeismicEvent>('/seismic-events', options);
    }

    async getTsunamiWarnings(options: PollRequestOptions): Promise<TsunamiWarning[]> {
        return this.getRecords<TsunamiWarning>('/tsunami-warnings', options);
    }

    private async getRecords<T>(path: string, options: PollRequestOptions): Promise<T[]> {
        const url = new URL(path, env.BMKG_BASE_URL);
        if (options.since) {
            url.searchParams.set('since', options.since.toISOString());
        }

        const startedAt = Date.now();
        let statusCode: number | undefined;

        try {
            const response = await fetch(url, {
                headers: {
                    'X-BMKG-Key': env.BMKG_API_KEY,
                    'X-Correlation-ID': options.correlationId,
                },
                signal: AbortSignal.timeout(env.BMKG_REQUEST_TIMEOUT_MS),
            });
            statusCode = response.status;

            if (!response.ok) {
                throw new Error(`BMKG request failed with HTTP ${response.status}`);
            }

            return getRecordsFromResponse<T>(await response.json());
        } finally {
            logger.info(
                {
                    source: 'BMKG',
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
