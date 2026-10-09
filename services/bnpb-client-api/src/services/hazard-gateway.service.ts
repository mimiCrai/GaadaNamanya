import { injectable } from 'inversify';
import { ApiError } from '../errors/api-error';
import { logger } from '../libs/logger';
import { UserRole } from '../types/auth';
import env from '../util/env';

export type HazardClassification = 'ringkasan' | 'mentah';
export type HazardSource = 'BMKG' | 'PVMBG';
export type SourceStatus = 'HEALTHY' | 'STALE' | 'UNAVAILABLE';

export const HAZARD_SOURCES: readonly HazardSource[] = ['BMKG', 'PVMBG'];

export interface Hazard {
    Field: string;
    Tipe: string;
    Klasifikasi: HazardClassification;
    Keterangan: string;
}

export interface SourceFreshness {
    status: SourceStatus;
    lastSuccessfulPollAt: string | null;
    staleSince: string | null;
}

export interface HazardMeta {
    sources: Partial<Record<HazardSource, SourceFreshness>>;
}

export interface HazardListResult {
    data: Hazard[];
    meta: HazardMeta;
}

export interface HazardResult {
    data: Hazard;
    meta: HazardMeta;
}

interface CanonicalHazardEvent {
    hazardId: string;
    source: HazardSource;
    sourceRefId: string;
    hazardType: 'SEISMIC' | 'VOLCANIC';
    severity: 'NORMAL' | 'WASPADA' | 'SIAGA' | 'AWAS';
    areaName: string;
    latitude: number;
    longitude: number;
    occurredAt: string;
    ingestedAt: string;
    attributes: Record<string, unknown>;
}

interface GatewayBody {
    data: unknown;
    meta?: unknown;
}

const SOURCE_STREAMS: Record<HazardSource, readonly string[]> = {
    BMKG: ['BMKG_SEISMIC', 'BMKG_TSUNAMI_WARNING'],
    PVMBG: ['PVMBG_VOLCANIC'],
};

const STATUS_RANK: Record<SourceStatus, number> = { HEALTHY: 0, STALE: 1, UNAVAILABLE: 2 };

export interface IHazardGateway {
    list(classification: HazardClassification, correlationId: string, source?: HazardSource): Promise<HazardListResult>;
    getById(hazardId: string, classification: HazardClassification, correlationId: string): Promise<HazardResult>;
}

@injectable()
export class HazardGateway implements IHazardGateway {
    async list(
        classification: HazardClassification,
        correlationId: string,
        source?: HazardSource
    ): Promise<HazardListResult> {
        const body = await this.request('/internal/hazards', correlationId, source ? { source } : {});
        if (!Array.isArray(body.data)) throw new ApiError('BNPB Gateway returned an invalid response', 502);
        return {
            data: body.data.map((hazard) => toClientHazard(validateCanonicalHazard(hazard), classification)),
            meta: { sources: toSourceFreshness(body.meta, source ? [source] : HAZARD_SOURCES) },
        };
    }

    async getById(hazardId: string, classification: HazardClassification, correlationId: string): Promise<HazardResult> {
        const body = await this.request(`/internal/hazards/${encodeURIComponent(hazardId)}`, correlationId);
        const hazard = validateCanonicalHazard(body.data);
        return {
            data: toClientHazard(hazard, classification),
            meta: { sources: toSourceFreshness(body.meta, [hazard.source]) },
        };
    }

    private async request(path: string, correlationId: string, query: Record<string, string> = {}): Promise<GatewayBody> {
        const url = new URL(path, `${env.BNPB_GATEWAY_BASE_URL}/`);
        for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);

        let response: Response;
        let body: unknown;
        const startedAt = Date.now();
        try {
            response = await fetch(url, {
                headers: {
                    accept: 'application/json',
                    'X-BNPB-Internal-Key': env.BNPB_INTERNAL_API_KEY,
                    'X-Correlation-ID': correlationId,
                },
                signal: AbortSignal.timeout(env.BNPB_GATEWAY_TIMEOUT_MS),
            });
            body = response.ok ? await response.json() : undefined;
        } catch (error) {
            const errorName = (error as { name?: unknown } | null)?.name;
            const timedOut = errorName === 'TimeoutError';
            logger.error(
                { target: 'bnpb-aggregator', path, correlationId, latencyMs: Date.now() - startedAt, timedOut },
                'Outgoing request failed'
            );
            if (timedOut) throw new ApiError('BNPB Gateway did not respond in time', 504);
            if (errorName === 'SyntaxError') throw new ApiError('BNPB Gateway returned an invalid response', 502);
            throw new ApiError('BNPB Gateway is unavailable', 502);
        }
        logger.info(
            { target: 'bnpb-aggregator', path, status: response.status, correlationId, latencyMs: Date.now() - startedAt },
            'Outgoing request completed'
        );
        if (response.status === 404) throw new ApiError('Hazard not found', 404);
        if (!response.ok) throw new ApiError('BNPB Gateway request failed', 502);

        if (!body || typeof body !== 'object' || !('data' in body)) {
            throw new ApiError('BNPB Gateway returned an invalid response', 502);
        }
        return body as GatewayBody;
    }
}

export function classificationForRole(role: UserRole): HazardClassification {
    return role === 'public' ? 'ringkasan' : 'mentah';
}

function toSourceFreshness(meta: unknown, sources: readonly HazardSource[]): HazardMeta['sources'] {
    const pollingStatus =
        meta && typeof meta === 'object' && 'pollingStatus' in meta && meta.pollingStatus && typeof meta.pollingStatus === 'object'
            ? (meta.pollingStatus as Record<string, unknown>)
            : {};

    return Object.fromEntries(
        sources.map((source) => {
            const streams = SOURCE_STREAMS[source].map((stream) => readStreamStatus(pollingStatus[stream]));
            const status = streams.reduce<SourceStatus>(
                (worst, stream) => (STATUS_RANK[stream.status] > STATUS_RANK[worst] ? stream.status : worst),
                'HEALTHY'
            );
            return [
                source,
                {
                    status,
                    lastSuccessfulPollAt: earliest(streams.map((stream) => stream.lastSuccessfulPollAt), true),
                    staleSince: status === 'HEALTHY' ? null : earliest(streams.map((stream) => stream.staleSince), false),
                },
            ];
        })
    );
}

function readStreamStatus(value: unknown): SourceFreshness {
    const stream = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const status = ['HEALTHY', 'STALE', 'UNAVAILABLE'].includes(stream.status as string)
        ? (stream.status as SourceStatus)
        : 'UNAVAILABLE';
    return {
        status,
        lastSuccessfulPollAt: typeof stream.lastSuccessfulPollAt === 'string' ? stream.lastSuccessfulPollAt : null,
        staleSince: typeof stream.staleSince === 'string' ? stream.staleSince : null,
    };
}

function earliest(values: (string | null)[], nullWins: boolean): string | null {
    if (nullWins && values.includes(null)) return null;
    const present = values.filter((value): value is string => value !== null);
    if (present.length === 0) return null;
    return present.reduce((min, value) => (Date.parse(value) < Date.parse(min) ? value : min));
}

function validateCanonicalHazard(value: unknown): CanonicalHazardEvent {
    if (!value || typeof value !== 'object') throw new ApiError('BNPB Gateway returned an invalid response', 502);
    const hazard = value as Record<string, unknown>;
    if (
        typeof hazard.hazardId !== 'string' ||
        (hazard.source !== 'BMKG' && hazard.source !== 'PVMBG') ||
        typeof hazard.sourceRefId !== 'string' ||
        (hazard.hazardType !== 'SEISMIC' && hazard.hazardType !== 'VOLCANIC') ||
        !['NORMAL', 'WASPADA', 'SIAGA', 'AWAS'].includes(hazard.severity as string) ||
        typeof hazard.areaName !== 'string' ||
        typeof hazard.latitude !== 'number' ||
        typeof hazard.longitude !== 'number' ||
        typeof hazard.occurredAt !== 'string' ||
        typeof hazard.ingestedAt !== 'string' ||
        !hazard.attributes ||
        typeof hazard.attributes !== 'object' ||
        Array.isArray(hazard.attributes)
    ) {
        throw new ApiError('BNPB Gateway returned an invalid response', 502);
    }

    return {
        hazardId: hazard.hazardId as string,
        source: hazard.source as CanonicalHazardEvent['source'],
        sourceRefId: hazard.sourceRefId as string,
        hazardType: hazard.hazardType as CanonicalHazardEvent['hazardType'],
        severity: hazard.severity as CanonicalHazardEvent['severity'],
        areaName: hazard.areaName as string,
        latitude: hazard.latitude as number,
        longitude: hazard.longitude as number,
        occurredAt: hazard.occurredAt as string,
        ingestedAt: hazard.ingestedAt as string,
        attributes: hazard.attributes as Record<string, unknown>,
    };
}

function toClientHazard(hazard: CanonicalHazardEvent, classification: HazardClassification): Hazard {
    const summary = `Kejadian ${hazard.hazardType} berstatus ${hazard.severity} di ${hazard.areaName} pada ${hazard.occurredAt}.`;

    return {
        Field: hazard.areaName,
        Tipe: hazard.hazardType,
        Klasifikasi: classification,
        Keterangan: classification === 'ringkasan' ? summary : JSON.stringify(hazard),
    };
}
