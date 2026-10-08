import { injectable } from 'inversify';
import { ApiError } from '../errors/api-error';
import { logger } from '../libs/logger';
import { UserRole } from '../types/auth';
import env from '../util/env';

export type HazardClassification = 'ringkasan' | 'mentah';

export interface Hazard {
    Field: string;
    Tipe: string;
    Klasifikasi: HazardClassification;
    Keterangan: string;
}

interface CanonicalHazardEvent {
    hazardId: string;
    source: 'BMKG' | 'PVMBG';
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

export interface IHazardGateway {
    list(classification: HazardClassification, correlationId: string): Promise<Hazard[]>;
    getById(hazardId: string, classification: HazardClassification, correlationId: string): Promise<Hazard>;
}

@injectable()
export class HazardGateway implements IHazardGateway {
    async list(classification: HazardClassification, correlationId: string): Promise<Hazard[]> {
        const result = await this.request('/internal/hazards', correlationId);
        if (!Array.isArray(result)) throw new ApiError('BNPB Gateway returned an invalid response', 502);
        return result.map((hazard) => toClientHazard(validateCanonicalHazard(hazard), classification));
    }

    async getById(hazardId: string, classification: HazardClassification, correlationId: string): Promise<Hazard> {
        const result = await this.request(`/internal/hazards/${encodeURIComponent(hazardId)}`, correlationId);
        return toClientHazard(validateCanonicalHazard(result), classification);
    }

    private async request(path: string, correlationId: string): Promise<unknown> {
        const url = new URL(path, `${env.BNPB_GATEWAY_BASE_URL}/`);

        let response: Response;
        const startedAt = Date.now();
        try {
            response = await fetch(url, {
                headers: {
                    accept: 'application/json',
                    'X-BNPB-Internal-Key': env.BNPB_INTERNAL_API_KEY,
                    'X-Correlation-ID': correlationId,
                },
            });
        } catch {
            logger.error(
                { target: 'bnpb-aggregator', path, correlationId, latencyMs: Date.now() - startedAt },
                'Outgoing request failed'
            );
            throw new ApiError('BNPB Gateway is unavailable', 502);
        }
        logger.info(
            { target: 'bnpb-aggregator', path, status: response.status, correlationId, latencyMs: Date.now() - startedAt },
            'Outgoing request completed'
        );
        if (response.status === 404) throw new ApiError('Hazard not found', 404);
        if (!response.ok) throw new ApiError('BNPB Gateway request failed', 502);

        const body = (await response.json()) as { data?: unknown };
        if (!body || !('data' in body)) throw new ApiError('BNPB Gateway returned an invalid response', 502);
        return body.data;
    }
}

export function classificationForRole(role: UserRole): HazardClassification {
    return role === 'public' ? 'ringkasan' : 'mentah';
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
