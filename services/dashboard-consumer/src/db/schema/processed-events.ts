import { timestamp, varchar } from 'drizzle-orm/pg-core';
import { pgTable } from 'drizzle-orm/pg-core';

export const processedEvents = pgTable('processed_events', {
    eventId: varchar('event_id', { length: 36 }).primaryKey(),
    processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
});
