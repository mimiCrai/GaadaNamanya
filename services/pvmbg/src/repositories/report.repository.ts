import { asc, count, desc, gte } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { Database } from '../db';
import { NewVolcanicReportRow, VolcanicReportRow, volcanicReports } from '../db/schema';
import { AlertLevel, VolcanicReport } from '../types/contract';

export interface ListQuery {
    since?: Date;
    limit: number;
}

export interface IReportRepository {
    insert(reports: VolcanicReport[]): Promise<number>;
    list(query: ListQuery): Promise<VolcanicReport[]>;
    count(): Promise<number>;
    latestLevels(): Promise<Map<string, AlertLevel>>;
}

@injectable()
export class ReportRepository implements IReportRepository {
    constructor(@inject(TYPES.Database) private readonly db: Database) {}

    async insert(reports: VolcanicReport[]): Promise<number> {
        if (reports.length === 0) return 0;
        const inserted = await this.db
            .insert(volcanicReports)
            .values(reports.map(toRow))
            .onConflictDoNothing({ target: volcanicReports.reportId })
            .returning({ reportId: volcanicReports.reportId });
        return inserted.length;
    }

    async list(query: ListQuery): Promise<VolcanicReport[]> {
        const rows = await this.db
            .select()
            .from(volcanicReports)
            .where(query.since === undefined ? undefined : gte(volcanicReports.reportedAt, query.since))
            .orderBy(asc(volcanicReports.reportedAt), asc(volcanicReports.reportId))
            .limit(query.limit);
        return rows.map(toReport);
    }

    async count(): Promise<number> {
        const [{ value }] = await this.db.select({ value: count() }).from(volcanicReports);
        return value;
    }

    async latestLevels(): Promise<Map<string, AlertLevel>> {
        const rows = await this.db
            .selectDistinctOn([volcanicReports.volcanoId], {
                volcanoId: volcanicReports.volcanoId,
                alertLevel: volcanicReports.alertLevel,
            })
            .from(volcanicReports)
            .orderBy(volcanicReports.volcanoId, desc(volcanicReports.reportedAt));
        return new Map(rows.map((row) => [row.volcanoId, row.alertLevel]));
    }
}

function toRow(report: VolcanicReport): NewVolcanicReportRow {
    return {
        reportId: report.report_id,
        volcanoId: report.volcano_id,
        alertLevel: report.alert_level,
        eruptionCount24h: report.eruption_count_24h,
        ashColumnHeightM: report.ash_column_height_m,
        reportedAt: new Date(report.reported_at),
        confidenceLevel: report.confidence_level ?? null,
    };
}

function toReport(row: VolcanicReportRow): VolcanicReport {
    const report: VolcanicReport = {
        report_id: row.reportId,
        volcano_id: row.volcanoId,
        alert_level: row.alertLevel,
        eruption_count_24h: row.eruptionCount24h,
        ash_column_height_m: row.ashColumnHeightM,
        reported_at: row.reportedAt.toISOString(),
    };
    
    if (row.confidenceLevel !== null) {
        report.confidence_level = row.confidenceLevel;
    }
    return report;
}
