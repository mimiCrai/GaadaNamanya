import { desc } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inject, injectable } from 'inversify';
import { HazardEventMessage } from '../contracts/hazard-event-message';
import { TYPES } from '../constants/types';
import * as schema from '../db/schema';
import { DashboardHazard, dashboardHazards } from '../db/schema/dashboard-hazards';
import { processedEvents } from '../db/schema/processed-events';

export interface IDashboardProjectionRepository {
    apply(message: HazardEventMessage): Promise<boolean>;
    findAll(): Promise<DashboardHazard[]>;
}

@injectable()
export class DashboardProjectionRepository implements IDashboardProjectionRepository {
    constructor(@inject(TYPES.Database) private readonly db: NodePgDatabase<typeof schema>) {}

    async apply(message: HazardEventMessage): Promise<boolean> {
        return this.db.transaction(async (tx) => {
            const inserted = await tx
                .insert(processedEvents)
                .values({ eventId: message.eventId })
                .onConflictDoNothing()
                .returning({ eventId: processedEvents.eventId });

            if (inserted.length === 0) {
                return false;
            }

            await tx
                .insert(dashboardHazards)
                .values({
                    hazardId: message.hazard.hazardId,
                    source: message.hazard.source,
                    hazardType: message.hazard.hazardType,
                    severity: message.hazard.severity,
                    areaName: message.hazard.areaName,
                    attributes: message.hazard.attributes,
                    occurredAt: new Date(message.hazard.occurredAt),
                    lastEventId: message.eventId,
                    lastEventType: message.eventType,
                    updatedAt: new Date(),
                })
                .onConflictDoUpdate({
                    target: dashboardHazards.hazardId,
                    set: {
                        source: message.hazard.source,
                        hazardType: message.hazard.hazardType,
                        severity: message.hazard.severity,
                        areaName: message.hazard.areaName,
                        attributes: message.hazard.attributes,
                        occurredAt: new Date(message.hazard.occurredAt),
                        lastEventId: message.eventId,
                        lastEventType: message.eventType,
                        updatedAt: new Date(),
                    },
                });

            return true;
        });
    }

    async findAll(): Promise<DashboardHazard[]> {
        return this.db.select().from(dashboardHazards).orderBy(desc(dashboardHazards.updatedAt));
    }
}
