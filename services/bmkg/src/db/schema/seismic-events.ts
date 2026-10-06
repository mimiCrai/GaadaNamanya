import { boolean, doublePrecision, index, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

export const seismicEvents = pgTable(
    'seismic_events',
    {
        eventId: varchar('event_id', { length: 64 }).primaryKey(),
        magnitude: doublePrecision('magnitude').notNull(),
        depthKm: doublePrecision('depth_km').notNull(),
        epicenterLat: doublePrecision('epicenter_lat').notNull(),
        epicenterLon: doublePrecision('epicenter_lon').notNull(),
        regionName: varchar('region_name', { length: 255 }).notNull(),
        occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
        potentialTsunami: boolean('potential_tsunami').notNull(),
    },
    
    (table) => [index('seismic_events_occurred_at_idx').on(table.occurredAt, table.eventId)]
);

export type SeismicEventRow = typeof seismicEvents.$inferSelect;
export type NewSeismicEventRow = typeof seismicEvents.$inferInsert;
