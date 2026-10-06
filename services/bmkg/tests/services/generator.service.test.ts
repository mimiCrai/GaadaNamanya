import 'reflect-metadata';
import { loadConfig } from '../../src/config/env';
import { findRegion } from '../../src/data/regions';
import { createFaker } from '../../src/libs/faker';
import { createLogger } from '../../src/libs/logger';
import { EventRepository } from '../../src/repositories/event.repository';
import { GeneratorService, SEED_EVENT_COUNT } from '../../src/services/generator.service';
import { SeismicEventSchema, TsunamiWarningSchema } from '../../src/types/contract';
import { resetTestDb } from '../helpers';

const ALL = { limit: 1000 };

describe('GeneratorService', () => {
    let events: EventRepository;
    let generator: GeneratorService;

    const newGenerator = (seed: string, env: Record<string, string> = {}) =>
        new GeneratorService(
            loadConfig({ ...process.env, ...env }),
            createLogger({ level: 'silent' }),
            () => Date.now(),
            createFaker(seed),
            events
        );

    beforeEach(async () => {
        events = new EventRepository(await resetTestDb());
        generator = newGenerator('generator-test');
        await generator.seed();
    });

    it('seeds contract-valid events, including the 5.0 / 6.5 boundaries and an Awas warning', async () => {
        const seeded = await events.listEvents(ALL);
        const warnings = await events.listWarnings(ALL);

        expect(() => SeismicEventSchema.array().length(SEED_EVENT_COUNT).parse(seeded)).not.toThrow();
        expect(() => TsunamiWarningSchema.array().parse(warnings)).not.toThrow();
        expect(seeded.map((event) => event.magnitude)).toEqual(expect.arrayContaining([5.0, 6.5]));
        expect(warnings.map((warning) => warning.threat_level)).toContain('Awas');
    });

    it('does not seed again when the database already has data', async () => {
        await newGenerator('another-run').seed();

        expect(await events.countEvents()).toBe(SEED_EVENT_COUNT);
    });

    it('flags potential_tsunami only for M >= 6.5, depth <= 70 km offshore, each with exactly one warning', async () => {
        await generator.generate(100);
        await generator.generate(5, { forceTsunami: true });

        const warnings = await events.listWarnings(ALL);
        for (const event of await events.listEvents(ALL)) {
            const expected = event.magnitude >= 6.5 && event.depth_km <= 70 && findRegion(event.region_name).isSea;
            expect(event.potential_tsunami).toBe(expected);
            const related = warnings.filter((warning) => warning.related_event_id === event.event_id);
            expect(related).toHaveLength(expected ? 1 : 0);
        }
    });

    it('round-trips events and warnings exactly, and filters by time >= since', async () => {
        const {
            events: [event],
            warnings: [warning],
        } = await generator.generate(1, { forceTsunami: true });

        const storedEvents = await events.listEvents({ since: new Date(event.occurred_at), limit: 1000 });
        const storedWarnings = await events.listWarnings({ since: new Date(warning.issued_at), limit: 1000 });

        expect(storedEvents).toContainEqual(event);
        expect(storedWarnings).toContainEqual(warning);
        expect(storedEvents.every((stored) => stored.occurred_at >= event.occurred_at)).toBe(true);
    });

    it('stores a lagged warning once BMKG_WARNING_LAG_MS has passed', async () => {
        const lagged = newGenerator('lag-test', { BMKG_WARNING_LAG_MS: '50' });

        const { events: created, warnings } = await lagged.generate(1, { forceTsunami: true });
        expect(warnings).toHaveLength(0);
        expect(lagged.pendingWarnings).toBe(1);

        await new Promise((resolve) => setTimeout(resolve, 200));
        const stored = await events.listWarnings(ALL);
        expect(stored.map((warning) => warning.related_event_id)).toContain(created[0].event_id);
        lagged.stop();
    });
});
