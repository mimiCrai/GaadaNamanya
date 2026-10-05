import { Faker } from '@faker-js/faker';
import { inject, injectable } from 'inversify';
import { Logger } from 'pino';
import { AppConfig } from '../config/env';
import { Clock, TYPES } from '../constants/types';
import { VOLCANO_IDS, VOLCANO_STARTING_LEVELS } from '../data/volcanoes';
import { IReportStore } from '../repositories/report.store';
import { ALERT_LEVELS, AlertLevel, VolcanicReport } from '../types/contract';
import { SchemaService } from './schema.service';

export const SEED_REPORT_COUNT = 25;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const LEVEL_CHANGE_PROBABILITY = 0.3;

interface Range {
    min: number;
    max: number;
}

export const LEVEL_ACTIVITY: Readonly<Record<AlertLevel, { eruptions: Range; ashM: Range }>> = {
    Normal: { eruptions: { min: 0, max: 0 }, ashM: { min: 0, max: 0 } },
    Waspada: { eruptions: { min: 0, max: 3 }, ashM: { min: 50, max: 800 } },
    Siaga: { eruptions: { min: 2, max: 15 }, ashM: { min: 300, max: 2500 } },
    Awas: { eruptions: { min: 10, max: 50 }, ashM: { min: 1500, max: 8000 } },
};

@injectable()
export class GeneratorService {
    private interval?: NodeJS.Timeout;
    private readonly levels = new Map<string, AlertLevel>(Object.entries(VOLCANO_STARTING_LEVELS));

    constructor(
        @inject(TYPES.Config) private readonly config: AppConfig,
        @inject(TYPES.Logger) private readonly logger: Logger,
        @inject(TYPES.Clock) private readonly clock: Clock,
        @inject(TYPES.Faker) private readonly faker: Faker,
        @inject(TYPES.IReportStore) private readonly store: IReportStore,
        @inject(TYPES.SchemaService) private readonly schema: SchemaService
    ) {}

    // loads 25 historical v1 reports over the last 24 hours
    seed(): void {
        const now = this.clock();
        const times = Array.from(
            { length: SEED_REPORT_COUNT },
            () => Math.floor((now - this.faker.number.int({ min: MINUTE_MS, max: DAY_MS })) / 1000) * 1000
        ).sort((a, b) => a - b);

        const firstRound = this.faker.helpers.shuffle([...VOLCANO_IDS]);
        const reports = times.map((time, index) => {
            const volcanoId = index < firstRound.length ? firstRound[index] : this.pickVolcanoAndStep();
            return this.buildReport(volcanoId, time, false);
        });

        this.store.add(reports);
        this.logger.info({ volcanic_reports: reports.length }, 'Seeded historical PVMBG data');
    }

    generate(count: number): VolcanicReport[] {
        const reports: VolcanicReport[] = [];
        for (let i = 0; i < count; i++) {
            const report = this.buildReport(this.pickVolcanoAndStep(), this.clock(), this.schema.version === 2);
            this.store.add([report]);
            reports.push(report);
            this.logger.info(
                {
                    report_id: report.report_id,
                    volcano_id: report.volcano_id,
                    alert_level: report.alert_level,
                    schema_version: this.schema.version,
                },
                'Generated volcanic report'
            );
        }
        return reports;
    }

    // keeps running during outage 
    start(): void {
        if (this.config.reportIntervalMs === 0 || this.interval) return;
        this.interval = setInterval(() => {
            try {
                this.generate(1);
            } catch (error) {
                this.logger.error({ err: error }, 'Volcanic report generation failed');
            }
        }, this.config.reportIntervalMs);
        this.interval.unref();
        this.logger.info({ interval_ms: this.config.reportIntervalMs }, 'Volcanic report generator started');
    }

    stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
    }

    private pickVolcanoAndStep(): string {
        const volcanoId = this.faker.helpers.arrayElement(VOLCANO_IDS);
        const index = ALERT_LEVELS.indexOf(this.levels.get(volcanoId)!);
        if (this.faker.number.float({ min: 0, max: 1 }) < LEVEL_CHANGE_PROBABILITY) {
            const direction =
                index === 0 ? 1 : index === ALERT_LEVELS.length - 1 ? -1 : this.faker.helpers.arrayElement([-1, 1]);
            this.levels.set(volcanoId, ALERT_LEVELS[index + direction]);
        }
        return volcanoId;
    }

    private buildReport(volcanoId: string, reportedAtMs: number, withConfidence: boolean): VolcanicReport {
        const level = this.levels.get(volcanoId)!;
        const activity = LEVEL_ACTIVITY[level];
        const eruptions = this.faker.number.int(activity.eruptions);
        const ashM = eruptions === 0 ? 0 : this.faker.number.float({ ...activity.ashM, fractionDigits: 1 });

        const report: VolcanicReport = {
            report_id: this.newReportId(reportedAtMs),
            volcano_id: volcanoId,
            alert_level: level,
            eruption_count_24h: eruptions,
            ash_column_height_m: ashM,
            reported_at: new Date(reportedAtMs).toISOString(),
        };
        if (withConfidence) {
            report.confidence_level = this.faker.number.float({ min: 0.5, max: 0.99, fractionDigits: 2 });
        }
        return report;
    }

    // VR-<yyyyMMddHHmmss>-<6 hex>
    private newReportId(reportedAtMs: number): string {
        const stamp = new Date(reportedAtMs).toISOString().replace(/[-:T]/g, '').slice(0, 14);
        let id: string;
        do {
            id = `VR-${stamp}-${this.faker.string.hexadecimal({ length: 6, casing: 'lower', prefix: '' })}`;
        } while (this.store.has(id));
        return id;
    }
}
