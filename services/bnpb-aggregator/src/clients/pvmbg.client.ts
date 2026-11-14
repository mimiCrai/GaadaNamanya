import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { logger } from '../libs/logger';
import { HttpStatusError, ProcessingError } from '../libs/processing-error';
import { decodeJson, payloadTooLarge, RawRecord, readLimited, toRawRecords } from '../libs/safe-decode';
import { IPayloadStore } from '../repositories/payload-store.repository';
import type { UnprocessedPayload } from '../repositories/unprocessed-message.repository';
import env from '../util/env';
import { PollRequestOptions } from './source-client.types';

export const PVMBG_RESPONSE_KIND = 'poll.volcanic-response';
export const PVMBG_RECORD_KIND = 'poll.volcanic-report';
export const PVMBG_ENDPOINT = 'GET /volcanic-reports';

/**
 * One poll response. If the envelope decodes, every record keeps its own raw bytes so it can be isolated.
 * If the body cannot be decoded as a batch, `failure` holds the whole body as one message.
 */
export interface VolcanicReportBatch {
    records: RawRecord[];
    contentType: string;
    failure?: { error: ProcessingError; payload: UnprocessedPayload };
}

export interface IPvmbgClient {
    getVolcanicReports(options: PollRequestOptions): Promise<VolcanicReportBatch>;
}

@injectable()
export class PvmbgClient implements IPvmbgClient {
    constructor(@inject(TYPES.IPayloadStore) private readonly payloads: IPayloadStore) {}

    async getVolcanicReports(options: PollRequestOptions): Promise<VolcanicReportBatch> {
        const url = new URL('/volcanic-reports', env.PVMBG_BASE_URL);
        if (options.since) {
            url.searchParams.set('since', options.since.toISOString());
        }

        const startedAt = Date.now();
        let statusCode: number | undefined;
        let sizeBytes: number | undefined;

        try {
            const response = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${env.PVMBG_TOKEN}`,
                    'X-Correlation-ID': options.correlationId,
                    ...(options.instanceId
                        ? { 'X-BNPB-Instance-ID': options.instanceId, 'X-BNPB-Fence': String(options.fencingToken) }
                        : {}),
                },
                signal: AbortSignal.timeout(env.PVMBG_REQUEST_TIMEOUT_MS),
            });
            statusCode = response.status;

            if (!response.ok) {
                await response.body?.cancel().catch(() => undefined);
                throw new HttpStatusError('PVMBG', response.status);
            }

            const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
            const body = (response.body ?? emptyBody()) as unknown as AsyncIterable<Uint8Array>;
            const read = await readLimited(body, env.PVMBG_MAX_BODY_BYTES, () =>
                this.payloads.openSink({
                    source: 'PVMBG',
                    kind: PVMBG_RESPONSE_KIND,
                    correlationId: options.correlationId,
                })
            );
            sizeBytes = read.size;

            if (read.kind === 'overflow') {
                return {
                    records: [],
                    contentType,
                    failure: {
                        error: payloadTooLarge(read.size, env.PVMBG_MAX_BODY_BYTES),
                        payload: read.ref
                            ? { kind: 'stored', ref: read.ref, size: read.size, sha256: read.sha256 }
                            : { kind: 'inline', bytes: read.head },
                    },
                };
            }

            try {
                const parsed = decodeJson(read.bytes, { maxDepth: env.DECODE_MAX_DEPTH });
                return { records: toRawRecords(read.bytes, parsed), contentType };
            } catch (error) {
                if (!(error instanceof ProcessingError)) throw error;
                return { records: [], contentType, failure: { error, payload: { kind: 'inline', bytes: read.bytes } } };
            }
        } finally {
            logger.info(
                {
                    source: 'PVMBG',
                    path: '/volcanic-reports',
                    statusCode,
                    sizeBytes,
                    latencyMs: Date.now() - startedAt,
                    correlationId: options.correlationId,
                },
                'Completed outbound source request'
            );
        }
    }
}

async function* emptyBody(): AsyncIterable<Uint8Array> {}
