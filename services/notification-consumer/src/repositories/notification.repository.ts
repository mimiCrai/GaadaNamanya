import { desc } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inject, injectable } from 'inversify';
import { HazardEventMessage } from '../contracts/hazard-event-message';
import { TYPES } from '../constants/types';
import * as schema from '../db/schema';
import { Notification, notifications } from '../db/schema/notifications';
import { processedEvents } from '../db/schema/processed-events';

export interface INotificationRepository {
    apply(message: HazardEventMessage): Promise<'created' | 'ignored' | 'duplicate'>;
    findAll(): Promise<Notification[]>;
}

@injectable()
export class NotificationRepository implements INotificationRepository {
    constructor(@inject(TYPES.Database) private readonly db: NodePgDatabase<typeof schema>) {}

    async apply(message: HazardEventMessage): Promise<'created' | 'ignored' | 'duplicate'> {
        return this.db.transaction(async (tx) => {
            const inserted = await tx
                .insert(processedEvents)
                .values({ eventId: message.eventId })
                .onConflictDoNothing()
                .returning({ eventId: processedEvents.eventId });

            if (inserted.length === 0) {
                return 'duplicate';
            }

            if (message.hazard.severity !== 'SIAGA' && message.hazard.severity !== 'AWAS') {
                return 'ignored';
            }

            await tx.insert(notifications).values({
                eventId: message.eventId,
                hazardId: message.hazard.hazardId,
                eventType: message.eventType,
                severity: message.hazard.severity,
                areaName: message.hazard.areaName,
                title: `${message.hazard.severity} ${message.hazard.hazardType} hazard`,
                message: `${message.hazard.areaName} has a ${message.hazard.severity} hazard update.`,
                occurredAt: new Date(message.hazard.occurredAt),
            });
            return 'created';
        });
    }

    async findAll(): Promise<Notification[]> {
        return this.db.select().from(notifications).orderBy(desc(notifications.createdAt));
    }
}
