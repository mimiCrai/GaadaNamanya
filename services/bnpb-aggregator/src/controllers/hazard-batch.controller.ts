import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpPost } from 'inversify-express-utils';
import { z } from 'zod';
import { TYPES } from '../constants/types';
import { HazardSeverity, HazardSource, HazardType } from '../db/schema/hazard-events';
import { logger } from '../libs/logger';
import { hazardBatchOpsTotal } from '../libs/metrics';
import { HazardWriteOp, HazardWriteResult, IHazardWriteRepository } from '../repositories/hazard-write.repository';
import env from '../util/env';

export const HAZARD_BATCH_MAX_OPS = 500;

const BATCH_SOURCES = [HazardSource.Satelit] as const;

const hazardSchema = z
    .object({
        hazard_type: z.nativeEnum(HazardType),
        severity: z.nativeEnum(HazardSeverity),
        area_name: z.string().min(1).max(255),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        occurred_at: z.string().datetime({ offset: true }),
        attributes: z.record(z.unknown()),
    })
    .strict();
const identity = {
    source: z.enum(BATCH_SOURCES),
    source_ref_id: z.string().min(1).max(256),
    version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
};
export const hazardBatchSchema = z
    .object({
        ops: z
            .array(
                z.discriminatedUnion('op', [
                    z.object({ op: z.literal('upsert'), ...identity, hazard: hazardSchema }).strict(),
                    z.object({ op: z.literal('delete'), ...identity }).strict(),
                ])
            )
            .min(1)
            .max(HAZARD_BATCH_MAX_OPS),
    })
    .strict()
    .refine((body) => new Set(body.ops.map((op) => `${op.source}|${op.source_ref_id}`)).size === body.ops.length, {
        message: 'one op per (source, source_ref_id) per batch',
    });

export function toWriteOp(op: z.infer<typeof hazardBatchSchema>['ops'][number]): HazardWriteOp {
    const identityFields = { source: op.source, sourceRefId: op.source_ref_id, version: op.version };
    if (op.op === 'delete') return { op: 'delete', ...identityFields };
    const { hazard } = op;
    return {
        op: 'upsert',
        ...identityFields,
        hazard: {
            hazardType: hazard.hazard_type,
            severity: hazard.severity,
            areaName: hazard.area_name,
            latitude: hazard.latitude,
            longitude: hazard.longitude,
            occurredAt: new Date(hazard.occurred_at),
            attributes: hazard.attributes,
        },
    };
}

// bounded parallelism; each op is independent (distinct _id) and idempotent
export async function runLimited<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await work(items[index]);
        }
    });
    await Promise.all(lanes);
    return results;
}

// Usulan 3.4: idempotent batch upsert/delete; version = feed offset of the last change to that fire
@controller('/internal/hazards/batch', TYPES.InternalAuthMiddleware)
export class HazardBatchController {
    constructor(@inject(TYPES.IHazardWriteRepository) private readonly writes: IHazardWriteRepository) {}

    @httpPost('/')
    async batch(req: Request, res: Response) {
        const parsed = hazardBatchSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
            const detail = parsed.error.issues
                .slice(0, 3)
                .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
                .join('; ');
            return res.status(400).json({ error: { code: 'bad_request', message: `Invalid hazard batch (${detail})` } });
        }
        const correlationId = String(res.getHeader('X-Correlation-ID'));
        const ops = parsed.data.ops.map(toWriteOp);
        const results: HazardWriteResult[] = await runLimited(ops, env.HAZARD_BATCH_CONCURRENCY, (op) =>
            this.writes.apply(op, correlationId)
        );
        const totals = { applied: 0, unchanged: 0, skipped: 0 };
        results.forEach((result, index) => {
            totals[result.result]++;
            hazardBatchOpsTotal.inc({ source: ops[index].source, op: result.op, result: result.result });
        });
        logger.info({ ops: ops.length, ...totals, correlationId }, 'Applied hazard batch');
        return res.json({
            results: results.map((result) => ({
                op: result.op,
                source_ref_id: result.sourceRefId,
                hazard_id: result.hazardId,
                result: result.result,
            })),
            ...totals,
        });
    }
}
