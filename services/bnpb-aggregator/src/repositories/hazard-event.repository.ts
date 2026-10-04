import { desc, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import * as schema from '../db/schema';
import { HazardEvent, hazardEvents } from '../db/schema/hazard-events';

export interface IHazardEventRepository {
    findAll(): Promise<HazardEvent[]>;
    findByHazardId(hazardId: string): Promise<HazardEvent | undefined>;
}

@injectable()
export class HazardEventRepository implements IHazardEventRepository {
    constructor(@inject(TYPES.Database) private readonly db: NodePgDatabase<typeof schema>) {}

    async findAll(): Promise<HazardEvent[]> {
        return this.db.select().from(hazardEvents).orderBy(desc(hazardEvents.occurredAt));
    }

    async findByHazardId(hazardId: string): Promise<HazardEvent | undefined> {
        const [hazardEvent] = await this.db.select().from(hazardEvents).where(eq(hazardEvents.hazardId, hazardId));
        return hazardEvent;
    }
}
