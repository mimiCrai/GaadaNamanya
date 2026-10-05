import { timestamp, varchar } from 'drizzle-orm/pg-core';
import { pgTable } from 'drizzle-orm/pg-core';

export const dashboardHazards = pgTable('dashboard_hazards', {
    hazardId: varchar('hazard_id', { length: 36 }).primaryKey(),
    source: varchar('source', { length: 16 }).notNull(),
    hazardType: varchar('hazard_type', { length: 16 }).notNull(),
    severity: varchar('severity', { length: 16 }).notNull(),
    areaName: varchar('area_name', { length: 255 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    lastEventId: varchar('last_event_id', { length: 36 }).notNull(),
    lastEventType: varchar('last_event_type', { length: 64 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export type DashboardHazard = typeof dashboardHazards.$inferSelect;
