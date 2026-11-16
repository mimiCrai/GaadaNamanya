import { injectable } from 'inversify';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { logger } from '../libs/logger';
import env from '../util/env';
import { PollRequestOptions } from './source-client.types';
import { SensorClientError, SensorPage, SensorStation, sensorStationSchema } from './sensor-pantai.types';

export interface ISensorPantaiClient {
    getStations(options: PollRequestOptions): Promise<SensorStation[]>;
    getObservations(cursor: string | null, options: PollRequestOptions): Promise<SensorPage>;
}

@injectable()
export class SensorPantaiClient implements ISensorPantaiClient {
    async getStations(options: PollRequestOptions): Promise<SensorStation[]> {
        const { body, raw } = await this.request('/v1/stations', options);
        const parsed = z.object({ items: z.array(sensorStationSchema).max(1000) }).safeParse(body);
        if (
            !parsed.success ||
            new Set(parsed.data.items.map((station) => station.station_id)).size !== parsed.data.items.length
        ) {
            throw new SensorClientError('Invalid station response', undefined, raw);
        }
        return parsed.data.items;
    }

    async getObservations(cursor: string | null, options: PollRequestOptions): Promise<SensorPage> {
        const path = new URL('/v1/observations', env.SENSOR_PANTAI_BASE_URL);
        path.searchParams.set('limit', String(env.SENSOR_PANTAI_PAGE_SIZE));
        if (cursor !== null) path.searchParams.set('cursor', cursor);
        const { body, raw } = await this.request(path.pathname + path.search, options);
        const parsed = z
            .object({
                generated_at: z.string().datetime({ offset: true }),
                items: z.array(z.unknown()).max(2000),
                next_cursor: z.string().min(1).max(4096).nullable(),
            })
            .safeParse(body);
        if (!parsed.success) throw new SensorClientError('Invalid observation response', undefined, raw);
        return {
            generatedAt: new Date(parsed.data.generated_at),
            items: parsed.data.items,
            nextCursor: parsed.data.next_cursor,
        };
    }

    private async request(path: string, options: PollRequestOptions): Promise<{ body: unknown; raw: string }> {
        const startedAt = performance.now();
        let statusCode: number | undefined;
        try {
            const response = await fetch(new URL(path, env.SENSOR_PANTAI_BASE_URL), {
                headers: {
                    Authorization: `Bearer ${env.SENSOR_PANTAI_TOKEN}`,
                    'X-Correlation-ID': options.correlationId,
                    'X-BNPB-Instance-ID': options.instanceId ?? '',
                    'X-BNPB-Fence': String(options.fencingToken ?? ''),
                },
                signal: AbortSignal.timeout(env.SENSOR_PANTAI_REQUEST_TIMEOUT_MS),
                redirect: 'error',
            });
            statusCode = response.status;
            if (!response.ok) {
                await response.body?.cancel();
                const retryAfter = Number(response.headers.get('retry-after'));
                throw new SensorClientError(
                    `Sensor Pantai returned HTTP ${response.status}`,
                    response.status,
                    undefined,
                    false,
                    Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60000) : 0
                );
            }
            const chunks: Buffer[] = [];
            let size = 0;
            const reader = response.body?.getReader();
            if (!reader) throw new SensorClientError('Empty Sensor Pantai response');
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const remaining = env.SENSOR_PANTAI_MAX_RESPONSE_BYTES - size;
                    chunks.push(Buffer.from(value.subarray(0, Math.max(remaining, 0))));
                    size += value.length;
                    if (size > env.SENSOR_PANTAI_MAX_RESPONSE_BYTES) {
                        throw new SensorClientError(
                            'Sensor Pantai response exceeds size limit',
                            undefined,
                            Buffer.concat(chunks).toString('base64'),
                            true
                        );
                    }
                }
            } finally {
                await reader.cancel().catch(() => undefined);
            }
            const bytes = Buffer.concat(chunks);
            let text: string;
            try {
                text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
                throw new SensorClientError(
                    'Sensor Pantai response is not valid UTF-8',
                    undefined,
                    bytes.toString('base64')
                );
            }
            let depth = 0;
            let quoted = false;
            let escaped = false;
            for (const character of text) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (quoted && character === '\\') {
                    escaped = true;
                    continue;
                }
                if (character === '"') quoted = !quoted;
                if (!quoted && (character === '{' || character === '[')) depth++;
                if (!quoted && (character === '}' || character === ']')) depth--;
                if (depth > 20)
                    throw new SensorClientError(
                        'Sensor Pantai JSON exceeds nesting limit',
                        undefined,
                        bytes.toString('base64')
                    );
            }
            try {
                return { body: JSON.parse(text), raw: bytes.toString('base64') };
            } catch {
                throw new SensorClientError(
                    'Sensor Pantai response is not valid JSON',
                    undefined,
                    bytes.toString('base64')
                );
            }
        } finally {
            logger.info(
                {
                    source: 'SENSOR_PANTAI',
                    path: path.split('?')[0],
                    statusCode,
                    latencyMs: performance.now() - startedAt,
                    correlationId: options.correlationId,
                },
                'Completed outbound source request'
            );
        }
    }
}
