import { doublePrecision, index, integer, pgEnum, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';
import { ALERT_LEVELS } from '../../types/contract';

export const alertLevelEnum = pgEnum('alert_level', ALERT_LEVELS);

export const volcanicReports = pgTable(
    'volcanic_reports',
    {
        reportId: varchar('report_id', { length: 64 }).primaryKey(),
        volcanoId: varchar('volcano_id', { length: 64 }).notNull(),
        alertLevel: alertLevelEnum('alert_level').notNull(),
        eruptionCount24h: integer('eruption_count_24h').notNull(),
        ashColumnHeightM: doublePrecision('ash_column_height_m').notNull(),
        reportedAt: timestamp('reported_at', { withTimezone: true }).notNull(),
        confidenceLevel: doublePrecision('confidence_level'),
    },
    (table) => [
        index('volcanic_reports_reported_at_idx').on(table.reportedAt, table.reportId),
        index('volcanic_reports_volcano_reported_at_idx').on(table.volcanoId, table.reportedAt),
    ]
);

export type VolcanicReportRow = typeof volcanicReports.$inferSelect;
export type NewVolcanicReportRow = typeof volcanicReports.$inferInsert;
