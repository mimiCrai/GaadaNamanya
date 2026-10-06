import 'reflect-metadata';
import { loadConfig } from '../../src/config/env';
import { VOLCANO_IDS } from '../../src/data/volcanoes';
import { createFaker } from '../../src/libs/faker';
import { createLogger } from '../../src/libs/logger';
import { ReportRepository } from '../../src/repositories/report.repository';
import { GeneratorService, LEVEL_ACTIVITY, SEED_REPORT_COUNT } from '../../src/services/generator.service';
import { SchemaService } from '../../src/services/schema.service';
import { VolcanicReportV1Schema, VolcanicReportV2Schema } from '../../src/types/contract';
import { buildApp, resetTestDb, waitFor } from '../helpers';

const ALL = { limit: 1000 };

describe('GeneratorService', () => {
    let reports: ReportRepository;
    let schema: SchemaService;
    let generator: GeneratorService;

    const newGenerator = (seed: string) => {
        const logger = createLogger({ level: 'silent' });
        return new GeneratorService(loadConfig(), logger, () => Date.now(), createFaker(seed), reports, schema);
    };

    beforeEach(async () => {
        reports = new ReportRepository(await resetTestDb());
        schema = new SchemaService(createLogger({ level: 'silent' }), () => Date.now());
        generator = newGenerator('generator-test');
        await generator.seed();
    });

    it('seeds 25 v1 reports over the last 24 hours for known volcanoes only', async () => {
        const seeded = await reports.list(ALL);
        const oldest = Date.now() - 24 * 3600_000;

        expect(() => VolcanicReportV1Schema.array().length(SEED_REPORT_COUNT).parse(seeded)).not.toThrow();
        for (const report of seeded) {
            expect(VOLCANO_IDS).toContain(report.volcano_id);
            expect(Date.parse(report.reported_at)).toBeGreaterThanOrEqual(oldest);
        }
    });

    it('does not seed again when the database already has data, and resumes alert levels from it', async () => {
        await generator.generate(10);
        const latest = await reports.latestLevels();

        const restarted = newGenerator('another-run');
        await restarted.seed();

        expect(await reports.count()).toBe(SEED_REPORT_COUNT + 10);
        // levels only move one step per report, so the next report starts from the stored level
        const [next] = await restarted.generate(1);
        const index = (level: string) => Object.keys(LEVEL_ACTIVITY).indexOf(level);
        expect(Math.abs(index(next.alert_level) - index(latest.get(next.volcano_id)!))).toBeLessThanOrEqual(1);
    });

    it('keeps eruption_count_24h and ash_column_height_m consistent with alert_level', async () => {
        await generator.generate(200);

        for (const report of await reports.list(ALL)) {
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

    it('stores confidence_level only for reports created while schema v2 is active', async () => {
        schema.set(2);
        const v2Ids = new Set((await generator.generate(10)).map((report) => report.report_id));
        schema.set(1);
        await generator.generate(10);

        // read back from the database: v1 rows come out without the key, not with null
        const stored = await reports.list(ALL);
        const v2 = stored.filter((report) => v2Ids.has(report.report_id));
        const v1 = stored.filter((report) => !v2Ids.has(report.report_id));
        expect(v2).toHaveLength(10);
        expect(() => VolcanicReportV2Schema.array().parse(v2)).not.toThrow();
        expect(() => VolcanicReportV1Schema.array().parse(v1)).not.toThrow();
    });

    it('round-trips timestamps and values exactly, and filters by reported_at >= since', async () => {
        const [created] = await generator.generate(1);
        const stored = await reports.list({ since: new Date(created.reported_at), limit: 1000 });

        expect(stored).toContainEqual(created);
        expect(stored.every((report) => report.reported_at >= created.reported_at)).toBe(true);
    });
});

describe('Generator during an outage', () => {
    it('keeps producing reports while the outage is active', async () => {
        const { generator, outage, reports } = await buildApp({
            env: { PVMBG_REPORT_INTERVAL_MS: '20', PVMBG_REPORT_GENERATION_PROBABILITY: '1' },
        });
        outage.set(true, 'hang');
        generator.start();

        await waitFor(async () => (await reports.count()) >= SEED_REPORT_COUNT + 3);
        generator.stop();
        outage.set(false, 'error');
    });
});
