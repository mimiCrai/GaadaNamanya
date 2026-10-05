import { injectable } from 'inversify';
import { VolcanicReport } from '../types/contract';

export interface ListQuery {
    since?: Date;
    limit: number;
}

export interface IReportStore {
    add(reports: VolcanicReport[]): void;
    list(query: ListQuery): VolcanicReport[];
    has(reportId: string): boolean;
    readonly size: number;
}

// v2 record keeps confidence_level even after a switch back to v1.
@injectable()
export class ReportStore implements IReportStore {
    private readonly reports: VolcanicReport[] = [];
    private readonly reportIds = new Set<string>();

    add(reports: VolcanicReport[]): void {
        for (const report of reports) {
            if (this.reportIds.has(report.report_id)) {
                throw new Error(`Duplicate report_id ${report.report_id}`);
            }
            this.reportIds.add(report.report_id);
            insertSorted(this.reports, report);
        }
    }

    list(query: ListQuery): VolcanicReport[] {
        const sinceMs = query.since?.getTime();
        const matching =
            sinceMs === undefined
                ? this.reports
                : this.reports.filter((report) => Date.parse(report.reported_at) >= sinceMs);
        return matching.slice(0, query.limit);
    }

    has(reportId: string): boolean {
        return this.reportIds.has(reportId);
    }

    get size(): number {
        return this.reports.length;
    }
}

function insertSorted(reports: VolcanicReport[], report: VolcanicReport): void {
    const time = Date.parse(report.reported_at);
    let index = reports.length;
    while (index > 0 && Date.parse(reports[index - 1].reported_at) > time) {
        index--;
    }
    reports.splice(index, 0, report);
}
