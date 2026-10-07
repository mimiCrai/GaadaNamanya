import { Faker } from '@faker-js/faker';
import { inject, injectable } from 'inversify';
import { Logger } from 'pino';
import { AppConfig } from '../config/env';
import { Clock, TYPES } from '../constants/types';
import { VOLCANO_IDS, VOLCANO_STARTING_LEVELS } from '../data/volcanoes';
import { IReportRepository } from '../repositories/report.repository';
import { ALERT_LEVELS, AlertLevel, VolcanicReport } from '../types/contract';
import { SchemaService } from './schema.service';

export const SEED_REPORT_COUNT = 25;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const LEVEL_CHANGE_PROBABILITY = 0.3;
const MAX_ID_ATTEMPTS = 5;

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
        @inject(TYPES.IReportRepository) private readonly reports: IReportRepository,
        @inject(TYPES.SchemaService) private readonly schema: SchemaService
    ) {}

    // loads 25 historical v1 reports into empty database;
    async seed(): Promise<void> {
        const existing = await this.reports.count();
        if (existing > 0) {
            for (const [volcanoId, level] of await this.reports.latestLevels()) {
                if (this.levels.has(volcanoId)) this.levels.set(volcanoId, level);
            }
            this.logger.info({ volcanic_reports: existing }, 'Database already holds PVMBG data, skipping seed');
            return;
        }

        const now = this.clock();
        const times = Array.from(
            { length: SEED_REPORT_COUNT },
            () => Math.floor((now - this.faker.number.int({ min: MINUTE_MS, max: DAY_MS })) / 1000) * 1000
        ).sort((a, b) => a - b);

        const ids = new Set<string>();
        const firstRound = this.faker.helpers.shuffle([...VOLCANO_IDS]);
        const reports = times.map((time, index) => {
            const volcanoId = index < firstRound.length ? firstRound[index] : this.pickVolcanoAndStep();
            let report: VolcanicReport;
            do {
                report = this.buildReport(volcanoId, time, false);
            } while (ids.has(report.report_id));
            ids.add(report.report_id);
            return report;
        });

        await this.reports.insert(reports);
        this.logger.info({ volcanic_reports: reports.length }, 'Seeded historical PVMBG data');
    }

    async generate(count: number): Promise<VolcanicReport[]> {
        const created: VolcanicReport[] = [];
        for (let i = 0; i < count; i++) {
            const volcanoId = this.pickVolcanoAndStep();
            const withConfidence = this.schema.version === 2;
            const reportedAtMs = this.clock();

            let report: VolcanicReport | undefined;
            for (let attempt = 0; attempt < MAX_ID_ATTEMPTS && !report; attempt++) {
                const candidate = this.buildReport(volcanoId, reportedAtMs, withConfidence);
                if ((await this.reports.insert([candidate])) === 1) report = candidate;
            }
            if (!report) throw new Error('Could not generate a unique report_id');

            created.push(report);
            this.logger.info(
                {
                    report_id: report.report_id,
                    volcano_id: report.volcano_id,
                    alert_level: report.alert_level,
                    schema_version: withConfidence ? 2 : 1,
                },
                'Generated volcanic report'
            );
        }
        return created;
    }

    start(): void {
        if (this.config.reportIntervalMs === 0 || this.interval) return;
        this.interval = setInterval(() => {
            if (
                this.config.reportGenerationProbability === 0 ||
                (this.config.reportGenerationProbability < 1 &&
                    this.faker.number.float({ min: 0, max: 1 }) >= this.config.reportGenerationProbability)
            )
                return;
            this.generate(1).catch((error) => this.logger.error({ err: error }, 'Volcanic report generation failed'));
        }, this.config.reportIntervalMs);
        this.interval.unref();
        this.logger.info(
            { interval_ms: this.config.reportIntervalMs, generation_probability: this.config.reportGenerationProbability },
            'Volcanic report generator started'
        );
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
        return `VR-${stamp}-${this.faker.string.hexadecimal({ length: 6, casing: 'lower', prefix: '' })}`;
    }
}
