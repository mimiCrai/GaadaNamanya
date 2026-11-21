import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import { z } from 'zod';
import { TYPES } from '../constants/types';
import { HazardEvent, HazardType } from '../db/schema/hazard-events';
import { ICanonicalReadRepository } from '../repositories/canonical-read.repository';
import { IStorageTopologyService } from '../services/storage-topology.service';

const range = z
    .object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() })
    .refine((v) => !v.from || !v.to || Date.parse(v.from) < Date.parse(v.to), 'from must be before to');

@controller('/internal/analytics', TYPES.InternalAuthMiddleware)
export class AnalyticsController {
    constructor(
        @inject(TYPES.ICanonicalReadRepository) private readonly reader: ICanonicalReadRepository,
        @inject(TYPES.IStorageTopologyService) private readonly topology: IStorageTopologyService
    ) {}

    @httpGet('/')
    async analytics(req: Request, res: Response) {
        const parsed = range.safeParse(req.query);
        if (!parsed.success)
            return res.status(400).json({ error: { code: 'bad_request', message: 'Invalid UTC time range' } });
        const { from, to } = parsed.data;
        const bySource: Record<string, number> = {};
        const bySeverity: Record<string, number> = {};
        // TSUNAMI is an overlapping series of warned seismic events, not a stored hazard type.
        const byType: Record<string, number> = {
            ...Object.fromEntries(Object.values(HazardType).map((type) => [type, 0])),
            TSUNAMI: 0,
        };
        const byArea: Record<string, number> = {};
        const byMonth: Record<string, number> = {};
        const byDay: Record<string, Record<string, number>> = {};
        let total = 0;
        const increment = (counts: Record<string, number>, key: string) => {
            counts[key] = (counts[key] ?? 0) + 1;
        };
        const result = await this.reader.read<HazardEvent>(
            {
                collection: 'hazard_events',
                filter:
                    from || to
                        ? {
                              occurredAt: {
                                  ...(from ? { $gte: new Date(from) } : {}),
                                  ...(to ? { $lt: new Date(to) } : {}),
                              },
                          }
                        : {},
            },
            (items) => {
                for (const item of items) {
                    total++;
                    increment(bySource, item.source);
                    increment(bySeverity, item.severity);
                    increment(byType, item.hazardType);
                    increment(byArea, item.areaName);
                    const time = item.occurredAt.toISOString();
                    increment(byMonth, time.slice(0, 7));
                    const day = time.slice(0, 10);
                    byDay[day] ??= {};
                    increment(byDay[day], item.hazardType);
                    const warning = item.attributes?.tsunami_warning;
                    if (
                        item.hazardType === HazardType.Seismic &&
                        warning &&
                        typeof warning === 'object' &&
                        !Array.isArray(warning)
                    ) {
                        increment(byType, 'TSUNAMI');
                        increment(byDay[day], 'TSUNAMI');
                    }
                }
            }
        );
        const topology = await this.topology.inspect();
        const unavailable = [...new Set([...result.unavailable_units, ...topology.unavailable_units])].sort();
        return res.json({
            total,
            bySource,
            bySeverity,
            byType,
            byArea,
            byMonth: Object.fromEntries(Object.entries(byMonth).sort()),
            byDay: Object.fromEntries(Object.entries(byDay).sort()),
            range: { from: from ?? null, to: to ?? null },
            as_of: new Date().toISOString(),
            partial: result.partial || unavailable.length > 0,
            unavailable_units: unavailable,
            degraded: unavailable.length > 0 || (topology.degraded_units?.length ?? 0) > 0,
            degraded_units: topology.degraded_units ?? [],
        });
    }
}
