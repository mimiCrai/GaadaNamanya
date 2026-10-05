import { sql } from 'drizzle-orm';
import { doublePrecision, jsonb, pgEnum, pgTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

export enum HazardSource {
    Bmkg = 'BMKG',
    Pvmbg = 'PVMBG',
}

export enum HazardType {
    Seismic = 'SEISMIC',
    Volcanic = 'VOLCANIC',
}

export enum HazardSeverity {
    Normal = 'NORMAL',
    Waspada = 'WASPADA',
    Siaga = 'SIAGA',
    Awas = 'AWAS',
}

export const hazardSourceEnum = pgEnum('hazard_source', [HazardSource.Bmkg, HazardSource.Pvmbg]);
export const hazardTypeEnum = pgEnum('hazard_type', [HazardType.Seismic, HazardType.Volcanic]);
export const hazardSeverityEnum = pgEnum('hazard_severity', [
    HazardSeverity.Normal,
    HazardSeverity.Waspada,
    HazardSeverity.Siaga,
    HazardSeverity.Awas,
]);

export const hazardEvents = pgTable(
    'hazard_events',
    {
        hazardId: varchar('hazard_id', { length: 128 }).primaryKey(),
        source: hazardSourceEnum('source').notNull(),
        sourceRefId: varchar('source_ref_id', { length: 255 }).notNull(),
        hazardType: hazardTypeEnum('hazard_type').notNull(),
        severity: hazardSeverityEnum('severity').notNull(),
        areaName: varchar('area_name', { length: 255 }).notNull(),
        latitude: doublePrecision('latitude').notNull(),
        longitude: doublePrecision('longitude').notNull(),
        occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
        ingestedAt: timestamp('ingested_at', { withTimezone: true }).defaultNow().notNull(),
        attributes: jsonb('attributes')
            .$type<Record<string, unknown>>()
            .notNull()
            .default(sql`'{}'::jsonb`),
    },
    (table) => [uniqueIndex('hazard_events_source_ref_id_unique').on(table.source, table.sourceRefId)]
);

export type HazardEvent = typeof hazardEvents.$inferSelect;
export type NewHazardEvent = typeof hazardEvents.$inferInsert;
