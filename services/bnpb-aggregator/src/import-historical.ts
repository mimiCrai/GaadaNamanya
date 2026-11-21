import 'reflect-metadata';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import { db } from './db';
import { HazardSource, HazardType, HazardSeverity } from './db/schema/hazard-events';
import { HazardEventRepository } from './repositories/hazard-event.repository';
import { BackgroundLeaseRepository } from './repositories/background-lease.repository';
import env from './util/env';

const recordSchema = z.object({
    source: z.nativeEnum(HazardSource).refine((value) => [HazardSource.Bmkg, HazardSource.Pvmbg].includes(value)),
    sourceRefId: z.string().min(1),
    hazardType: z.nativeEnum(HazardType).refine((value) => [HazardType.Seismic, HazardType.Volcanic].includes(value)),
    severity: z.nativeEnum(HazardSeverity),
    areaName: z.string().min(1),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    occurredAt: z.string().datetime(),
    attributes: z.record(z.unknown()).default({}),
});

async function main(): Promise<void> {
    const file = process.argv[2];
    if (!file) throw new Error('Usage: npm run data:import -- /path/to/history.ndjson');
    const leases = new BackgroundLeaseRepository(db);
    const repository = new HazardEventRepository(db, leases);
    const ownerId = `historical-import:${hostname()}:${process.pid}:${randomUUID()}`;
    let leaseEpoch: number | undefined;
    let read = 0;
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    await db.connect();
    try {
        const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
        for await (const line of lines) {
            if (!line.trim()) continue;
            read++;
            let record: z.infer<typeof recordSchema>;
            try {
                record = recordSchema.parse(JSON.parse(line));
            } catch (error) {
                throw new Error(`Invalid historical record at line ${read}: ${String(error)}`);
            }
            const lease = await leases.acquireOrRenew(ownerId);
            if (!lease)
                throw new Error(
                    'Background lease is held by an aggregator; pause aggregator instances before importing'
                );
            leaseEpoch = lease.epoch;
            const result = await repository.upsertAndEnqueue({
                ...record,
                occurredAt: new Date(record.occurredAt),
                topic: env.KAFKA_TOPIC,
                correlationId: randomUUID(),
                lease: { ownerId, epoch: lease.epoch },
            });
            if (result.changeType === 'hazard.created') created++;
            else if (result.changeType === 'hazard.updated') updated++;
            else unchanged++;
        }
        console.log(JSON.stringify({ read, created, updated, unchanged }));
    } finally {
        try {
            if (leaseEpoch !== undefined) await leases.release({ ownerId, epoch: leaseEpoch });
        } finally {
            await db.close();
        }
    }
}

void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
