import 'reflect-metadata';
import { loadConfig } from '../../src/config/env';
import { VOLCANO_IDS } from '../../src/data/volcanoes';
import { createFaker } from '../../src/libs/faker';
import { createLogger } from '../../src/libs/logger';
import { ReportStore } from '../../src/repositories/report.store';
import { GeneratorService, LEVEL_ACTIVITY, SEED_REPORT_COUNT } from '../../src/services/generator.service';
import { SchemaService } from '../../src/services/schema.service';
import { VolcanicReportV1Schema, VolcanicReportV2Schema } from '../../src/types/contract';
import { buildApp } from '../helpers';

const ALL = { limit: 1000 };

describe('GeneratorService', () => {
    let store: ReportStore;
    let schema: SchemaService;
    let generator: GeneratorService;

    beforeEach(() => {
        const logger = createLogger({ level: 'silent' });
        const clock = () => Date.now();
        store = new ReportStore();
        schema = new SchemaService(logger, clock);
        generator = new GeneratorService(loadConfig(), logger, clock, createFaker('generator-test'), store, schema);
        generator.seed();
    });

    it('seeds 25 v1 reports over the last 24 hours for known volcanoes only', () => {
        const reports = store.list(ALL);
        const oldest = Date.now() - 24 * 3600_000;

        expect(() => VolcanicReportV1Schema.array().length(SEED_REPORT_COUNT).parse(reports)).not.toThrow();
        for (const report of reports) {
            expect(VOLCANO_IDS).toContain(report.volcano_id);
            expect(Date.parse(report.reported_at)).toBeGreaterThanOrEqual(oldest);
        }
    });

    it('keeps eruption_count_24h and ash_column_height_m consistent with alert_level', () => {
        generator.generate(300);

        for (const report of store.list(ALL)) {
            const { eruptions, ashM } = LEVEL_ACTIVITY[report.alert_level];
            expect(report.eruption_count_24h).toBeGreaterThanOrEqual(eruptions.min);
            expect(report.eruption_count_24h).toBeLessThanOrEqual(eruptions.max);
            if (report.eruption_count_24h === 0) {
                expect(report.ash_column_height_m).toBe(0);
            } else {
                expect(report.ash_column_height_m).toBeGreaterThanOrEqual(ashM.min);
                expect(report.ash_column_height_m).toBeLessThanOrEqual(ashM.max);
            }
        }
    });

    it('stamps confidence_level only on reports created while schema v2 is active', () => {
        schema.set(2);
        const v2 = generator.generate(20);
        schema.set(1);
        const v1 = generator.generate(20);

        expect(() => VolcanicReportV2Schema.array().parse(v2)).not.toThrow();
        expect(() => VolcanicReportV1Schema.array().parse(v1)).not.toThrow();
    });

    it('never returns the same report_id twice', () => {
        generator.generate(500);
        const ids = store.list(ALL).map((report) => report.report_id);

        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('Generator during an outage', () => {
    afterEach(() => jest.useRealTimers());

    it('keeps producing reports while the outage is active', () => {
        jest.useFakeTimers();
        const { generator, outage, store } = buildApp({ env: { PVMBG_REPORT_INTERVAL_MS: '5000' } });
        outage.set(true, 'hang');
        generator.start();

        jest.advanceTimersByTime(60_000);
        generator.stop();

        expect(store.size).toBe(SEED_REPORT_COUNT + 12);
    });
});
