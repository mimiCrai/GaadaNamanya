import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { inject, injectable } from 'inversify';
import { Document } from 'mongodb';
import { z } from 'zod';
import { TYPES } from '../constants/types';
import { HazardEvent } from '../db/schema/hazard-events';
import { SourceSyncState } from '../db/schema/source-sync-states';
import { ICanonicalReadRepository } from '../repositories/canonical-read.repository';
import { HazardReadQuery, ReadApiError } from '../types/canonical-read';
import { IStorageTopologyService } from './storage-topology.service';
import env from '../util/env';

const cursorSchema = z
    .object({
        v: z.literal(1),
        mode: z.enum(['audit', 'hazards']),
        source: z.string().nullable(),
        since: z.string().nullable(),
        time: z.string().datetime(),
        id: z.string().min(1),
        units: z.array(z.string()),
    })
    .strict();

export interface ICanonicalQueryService {
    events(query: HazardReadQuery): Promise<Record<string, unknown>>;
    checksum(source?: string): Promise<Record<string, unknown>>;
    location(hazardId: string): Promise<Record<string, unknown> | null>;
    hazards(query: HazardReadQuery): Promise<Record<string, unknown>>;
    hazard(hazardId: string): Promise<Record<string, unknown> | null>;
}

@injectable()
export class CanonicalQueryService implements ICanonicalQueryService {
    constructor(
        @inject(TYPES.ICanonicalReadRepository) private readonly reader: ICanonicalReadRepository,
        @inject(TYPES.IStorageTopologyService) private readonly topology: IStorageTopologyService
    ) {}

    async events(query: HazardReadQuery): Promise<Record<string, unknown>> {
        const page = await this.page(query, true);
        return {
            items: page.items.map(toAuditHazard),
            next_cursor: page.nextCursor,
            partial: page.partial,
            unavailable_units: page.unavailable_units,
        };
    }

    async checksum(source?: string): Promise<Record<string, unknown>> {
        const hash = createHash('sha256');
        let count = 0;
        const asOf = new Date().toISOString();
        const result = await this.reader.read<{ sourceRefId: string }>(
            {
                collection: 'hazard_events',
                filter: source ? { source } : {},
                sort: { sourceRefId: 1, hazardId: 1 },
                projection: { _id: 0, sourceRefId: 1 },
            },
            (batch) => {
                for (const item of batch) {
                    if (count > 0) hash.update('\n');
                    hash.update(item.sourceRefId, 'utf8');
                    count++;
                }
            }
        );
        return {
            source: source ?? null,
            count,
            checksum: hash.digest('hex'),
            algorithm: 'sha256',
            as_of: asOf,
            partial: result.partial,
            unavailable_units: result.unavailable_units,
        };
    }

    async location(hazardId: string): Promise<Record<string, unknown> | null> {
        const result = await this.reader.read<HazardEvent>({
            collection: 'hazard_events',
            filter: { _id: hazardId },
            limit: 1,
        });
        if (result.items.length === 0 && !result.partial) return null;
        let locations: Awaited<ReturnType<IStorageTopologyService['locate']>> = [];
        if (result.items.length > 0) {
            try {
                const status = await this.topology.inspect();
                result.unavailable_units.push(...status.unavailable_units);
                locations = await this.topology.locate(hazardId, status);
            } catch {
                result.unavailable_units.push('canonical-metadata');
            }
        }
        return {
            hazard_id: hazardId,
            locations,
            partial: result.partial || result.unavailable_units.length > 0,
            unavailable_units: [...new Set(result.unavailable_units)].sort(),
        };
    }

    async hazards(query: HazardReadQuery): Promise<Record<string, unknown>> {
        const [page, states] = await Promise.all([this.page(query, false), this.pollingStatus()]);
        const units = [...new Set([...page.unavailable_units, ...states.unavailable_units])].sort();
        return {
            data: page.items,
            meta: {
                pollingStatus: states.status,
                nextCursor: page.nextCursor,
                partial: page.partial || states.partial,
                unavailable_units: units,
            },
        };
    }

    async hazard(hazardId: string): Promise<Record<string, unknown> | null> {
        const [result, states] = await Promise.all([
            this.reader.read<HazardEvent>({ collection: 'hazard_events', filter: { _id: hazardId }, limit: 1 }),
            this.pollingStatus(),
        ]);
        if (!result.items.length && !result.partial) return null;
        return {
            data: result.items[0] ?? null,
            meta: {
                pollingStatus: states.status,
                partial: result.partial || states.partial,
                unavailable_units: [...new Set([...result.unavailable_units, ...states.unavailable_units])].sort(),
            },
        };
    }

    private async pollingStatus() {
        const result = await this.reader.read<SourceSyncState>({
            collection: 'source_sync_states',
            sort: { sourceStream: 1 },
        });
        return {
            ...result,
            status: Object.fromEntries(
                result.items.map((state) => [
                    state.sourceStream,
                    {
                        status: state.status,
                        lastSuccessfulPollAt: state.lastSuccessfulPollAt,
                        staleSince: state.staleSince,
                    },
                ])
            ),
        };
    }

    private async page(query: HazardReadQuery, audit: boolean) {
        const paged = audit || query.limit !== undefined || query.cursor !== undefined;
        const limit = query.limit ?? 100;
        const ascending = audit || query.since !== undefined;
        const field = ascending ? 'ingestedAt' : 'occurredAt';
        const direction = ascending ? 1 : -1;
        const mode = audit ? 'audit' : 'hazards';
        let previous: z.infer<typeof cursorSchema> | undefined;
        const conditions: Document[] = [];
        if (query.source) conditions.push({ source: query.source });
        if (query.since) conditions.push({ ingestedAt: { $gte: new Date(query.since) } });
        if (query.cursor) {
            previous = this.decodeCursor(query.cursor);
            if (
                previous.mode !== mode ||
                previous.source !== (query.source ?? null) ||
                previous.since !== (query.since ?? null)
            ) {
                throw new ReadApiError('bad_request', 'Cursor does not match this query');
            }
            conditions.push({
                $or: [
                    { [field]: { [ascending ? '$gt' : '$lt']: new Date(previous.time) } },
                    { [field]: new Date(previous.time), hazardId: { $gt: previous.id } },
                ],
            });
        }
        const result = await this.reader.read<HazardEvent>({
            collection: 'hazard_events',
            filter: conditions.length ? { $and: conditions } : {},
            sort: { [field]: direction, hazardId: 1 },
            ...(paged ? { limit: limit + 1 } : {}),
        });
        if (previous && JSON.stringify(previous.units) !== JSON.stringify(result.unavailable_units)) {
            throw new ReadApiError('bad_request', 'Storage availability changed; restart pagination without a cursor');
        }
        const items = paged ? result.items.slice(0, limit) : result.items;
        const last = items[items.length - 1];
        const nextCursor =
            paged && result.items.length > limit && last
                ? this.encodeCursor({
                      v: 1,
                      mode,
                      source: query.source ?? null,
                      since: query.since ?? null,
                      time: last[field].toISOString(),
                      id: last.hazardId,
                      units: result.unavailable_units,
                  })
                : null;
        return { ...result, items, nextCursor };
    }

    private encodeCursor(value: z.infer<typeof cursorSchema>): string {
        const body = Buffer.from(JSON.stringify(value)).toString('base64url');
        return `${body}.${createHmac('sha256', env.BNPB_INTERNAL_API_KEY).update(body).digest('base64url')}`;
    }

    private decodeCursor(cursor: string): z.infer<typeof cursorSchema> {
        try {
            if (cursor.length > 4096) throw new Error('Cursor too large');
            const parts = cursor.split('.');
            if (parts.length !== 2) throw new Error('Invalid cursor');
            const expected = createHmac('sha256', env.BNPB_INTERNAL_API_KEY).update(parts[0]).digest();
            const actual = Buffer.from(parts[1], 'base64url');
            if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
                throw new Error('Invalid signature');
            return cursorSchema.parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
        } catch {
            throw new ReadApiError('bad_request', 'Invalid cursor');
        }
    }
}

function toAuditHazard(hazard: HazardEvent) {
    return {
        hazard_id: hazard.hazardId,
        source: hazard.source,
        source_ref_id: hazard.sourceRefId,
        hazard_type: hazard.hazardType,
        severity: hazard.severity,
        area_name: hazard.areaName,
        latitude: hazard.latitude,
        longitude: hazard.longitude,
        occurred_at: hazard.occurredAt.toISOString(),
        ingested_at: hazard.ingestedAt.toISOString(),
        attributes: hazard.attributes,
    };
}
