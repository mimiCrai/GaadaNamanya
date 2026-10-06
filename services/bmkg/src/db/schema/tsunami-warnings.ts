import { index, pgEnum, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { THREAT_LEVELS } from '../../types/contract';
import { seismicEvents } from './seismic-events';

export const threatLevelEnum = pgEnum('threat_level', THREAT_LEVELS);

export const tsunamiWarnings = pgTable(
    'tsunami_warnings',
    {
        warningId: varchar('warning_id', { length: 64 }).primaryKey(),
        relatedEventId: varchar('related_event_id', { length: 64 })
            .notNull()
            .references(() => seismicEvents.eventId),
        threatLevel: threatLevelEnum('threat_level').notNull(),
        affectedZones: text('affected_zones').array().notNull(),
        estimatedArrival: timestamp('estimated_arrival', { withTimezone: true }).notNull(),
        issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    },
    
    (table) => [index('tsunami_warnings_issued_at_idx').on(table.issuedAt, table.warningId)]
);

export type TsunamiWarningRow = typeof tsunamiWarnings.$inferSelect;
export type NewTsunamiWarningRow = typeof tsunamiWarnings.$inferInsert;
