import { and, asc, count, desc, eq, gt, gte, or } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { Database } from '../db';
import { NewVolcanicReportRow, VolcanicReportRow, volcanicReports } from '../db/schema';
import { ALERT_LEVELS, AlertLevel, SchemaMode, VolcanicReport, WireReport } from '../types/contract';

export interface ListQuery {
    since?: Date;
    // with since: strictly after (since, afterId), the same order the list uses
    afterId?: string;
    limit: number;
}

export interface IReportRepository {
    insert(reports: VolcanicReport[], schemaMode?: SchemaMode): Promise<number>;
    list(query: ListQuery): Promise<VolcanicReport[]>;
    listWire(query: ListQuery): Promise<WireReport[]>;
    count(): Promise<number>;
    latestLevels(): Promise<Map<string, AlertLevel>>;
}

@injectable()
export class ReportRepository implements IReportRepository {
    constructor(@inject(TYPES.Database) private readonly db: Database) {}

    async insert(reports: VolcanicReport[], schemaMode?: SchemaMode): Promise<number> {
        if (reports.length === 0) return 0;
        const inserted = await this.db
            .insert(volcanicReports)
            .values(reports.map((report) => ({ ...toRow(report), schemaMode: schemaMode ?? null })))
            .onConflictDoNothing({ target: volcanicReports.reportId })
            .returning({ reportId: volcanicReports.reportId });
        return inserted.length;
    }

    async list(query: ListQuery): Promise<VolcanicReport[]> {
        return (await this.select(query)).map(toReport);
    }

    // wire shape per record (M2 schema modes); identical to list() for M1 records
    async listWire(query: ListQuery): Promise<WireReport[]> {
        return (await this.select(query)).map(toWire);
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

    private select(query: ListQuery): Promise<VolcanicReportRow[]> {
        return this.db
            .select()
            .from(volcanicReports)
            .where(sinceFilter(query))
            .orderBy(asc(volcanicReports.reportedAt), asc(volcanicReports.reportId))
            .limit(query.limit);
    }
}

function sinceFilter({ since, afterId }: ListQuery) {
    if (since === undefined) return undefined;
    if (afterId === undefined) return gte(volcanicReports.reportedAt, since);
    return or(
        gt(volcanicReports.reportedAt, since),
        and(eq(volcanicReports.reportedAt, since), gt(volcanicReports.reportId, afterId))
    );
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

// renders a record in the shape of the schema mode active when it was created
export function toWire(row: VolcanicReportRow): WireReport {
    const report: WireReport = { ...toReport(row) };
    switch (row.schemaMode as SchemaMode | null) {
        case 'rename_field':
            return Object.fromEntries(
                Object.entries(report).map(([key, value]) => (key === 'alert_level' ? ['level', value] : [key, value]))
            );
        case 'type_change':
            return { ...report, alert_level: ALERT_LEVELS.indexOf(row.alertLevel) };
        case 'missing_required':
            return Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'eruption_count_24h'));
        default:
            return report;
    }
}
