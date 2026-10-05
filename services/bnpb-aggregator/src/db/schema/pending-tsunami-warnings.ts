import { jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';
import { TsunamiWarning } from '../../clients/source-client.types';

export const pendingTsunamiWarnings = pgTable('pending_tsunami_warnings', {
    warningId: varchar('warning_id', { length: 255 }).primaryKey(),
    relatedEventId: varchar('related_event_id', { length: 255 }).notNull(),
    warning: jsonb('warning').$type<TsunamiWarning>().notNull(),
    firstReceivedAt: timestamp('first_received_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type PendingTsunamiWarning = typeof pendingTsunamiWarnings.$inferSelect;
