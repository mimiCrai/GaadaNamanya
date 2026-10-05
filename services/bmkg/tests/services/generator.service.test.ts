import 'reflect-metadata';
import { loadConfig } from '../../src/config/env';
import { findRegion } from '../../src/data/regions';
import { createFaker } from '../../src/libs/faker';
import { createLogger } from '../../src/libs/logger';
import { EventStore } from '../../src/repositories/event.store';
import { GeneratorService, SEED_EVENT_COUNT } from '../../src/services/generator.service';
import { SeismicEventSchema, TsunamiWarningSchema } from '../../src/types/contract';

const ALL = { limit: 1000 };

describe('GeneratorService', () => {
    let store: EventStore;
    let generator: GeneratorService;

    beforeEach(() => {
        store = new EventStore();
        generator = new GeneratorService(
            loadConfig(),
            createLogger({ level: 'silent' }),
            () => Date.now(),
            createFaker('generator-test'),
            store
        );
        generator.seed();
    });

    it('seeds contract-valid events, including the 5.0 / 6.5 boundaries and an Awas warning', () => {
        const events = store.listEvents(ALL);
        const warnings = store.listWarnings(ALL);

        expect(() => SeismicEventSchema.array().length(SEED_EVENT_COUNT).parse(events)).not.toThrow();
        expect(() => TsunamiWarningSchema.array().parse(warnings)).not.toThrow();
        expect(events.map((event) => event.magnitude)).toEqual(expect.arrayContaining([5.0, 6.5]));
        expect(warnings.map((warning) => warning.threat_level)).toContain('Awas');
    });

    it('flags potential_tsunami only for M >= 6.5, depth <= 70 km offshore, each with exactly one warning', () => {
        generator.generate(100);
        generator.generate(5, { forceTsunami: true });

        const warnings = store.listWarnings(ALL);
        for (const event of store.listEvents(ALL)) {
            const expected = event.magnitude >= 6.5 && event.depth_km <= 70 && findRegion(event.region_name).isSea;
            expect(event.potential_tsunami).toBe(expected);
            const related = warnings.filter((warning) => warning.related_event_id === event.event_id);
            expect(related).toHaveLength(expected ? 1 : 0);
        }
    });
});
