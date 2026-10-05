import { Faker } from '@faker-js/faker';
import { inject, injectable } from 'inversify';
import { Logger } from 'pino';
import { AppConfig } from '../config/env';
import { Clock, TYPES } from '../constants/types';
import { findRegion, SEA_REGIONS, SEISMIC_REGIONS, SeismicRegion } from '../data/regions';
import { IEventStore } from '../repositories/event.store';
import { SeismicEvent, ThreatLevel, TsunamiWarning } from '../types/contract';

export const SEED_EVENT_COUNT = 25;
export const TSUNAMI_MIN_MAGNITUDE = 6.5;
export const TSUNAMI_MAX_DEPTH_KM = 70;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

interface EventSpec {
    magnitude?: number;
    depthKm?: number;
    regionName?: string;
    forceTsunami?: boolean;
}

const SEED_ANCHORS: EventSpec[] = [
    { magnitude: 5.0, depthKm: 10, regionName: 'Kabupaten Cianjur, Jawa Barat' },
    { magnitude: 6.5, depthKm: 25, regionName: 'Samudra Hindia Selatan Jawa Barat' },
    { magnitude: 7.6, depthKm: 18, regionName: 'Samudra Hindia Barat Daya Kepulauan Mentawai' },
    { magnitude: 7.1, depthKm: 35, regionName: 'Laut Maluku' },
    { magnitude: 6.8, depthKm: 40, regionName: 'Laut Banda' },
    { magnitude: 6.9, depthKm: 12, regionName: 'Kabupaten Lombok Utara, NTB' },
    { magnitude: 6.7, depthKm: 120, regionName: 'Laut Flores' },
];

export interface GenerateOptions {
    forceTsunami?: boolean;
}

export interface GenerateResult {
    events: SeismicEvent[];
    warnings: TsunamiWarning[];
}

export function isTsunamiPotential(magnitude: number, depthKm: number, region: SeismicRegion): boolean {
    return magnitude >= TSUNAMI_MIN_MAGNITUDE && depthKm <= TSUNAMI_MAX_DEPTH_KM && region.isSea;
}

export function threatLevelFor(magnitude: number): ThreatLevel {
    if (magnitude >= 7.5) return 'Awas';
    if (magnitude >= 7.0) return 'Siaga';
    return 'Waspada';
}

@injectable()
export class GeneratorService {
    private interval?: NodeJS.Timeout;
    private readonly lagTimers = new Set<NodeJS.Timeout>();

    constructor(
        @inject(TYPES.Config) private readonly config: AppConfig,
        @inject(TYPES.Logger) private readonly logger: Logger,
        @inject(TYPES.Clock) private readonly clock: Clock,
        @inject(TYPES.Faker) private readonly faker: Faker,
        @inject(TYPES.IEventStore) private readonly store: IEventStore
    ) {}

    // loads 25 historical events over the last 24 hours with their tsunami warnings
    seed(): void {
        const now = this.clock();
        const randomSpecs = Array.from({ length: SEED_EVENT_COUNT - SEED_ANCHORS.length }, (): EventSpec => ({}));

        const specs = this.faker.helpers.shuffle([...SEED_ANCHORS, ...randomSpecs]);
        const times = specs
            .map(() => Math.floor((now - this.faker.number.int({ min: MINUTE_MS, max: DAY_MS })) / 1000) * 1000)
            .sort((a, b) => a - b);

        const events: SeismicEvent[] = [];
        const warnings: TsunamiWarning[] = [];
        specs.forEach((spec, index) => {
            const { event, region } = this.buildEvent(times[index], spec);
            events.push(event);
            if (event.potential_tsunami) {
                const issuedAt = Math.min(times[index] + this.faker.number.int({ min: 60, max: 180 }) * 1000, now);
                warnings.push(this.buildWarning(event, region, issuedAt));
            }
        });

        this.store.addEvents(events);
        this.store.addWarnings(warnings);
        this.logger.info(
            { seismic_events: events.length, tsunami_warnings: warnings.length },
            'Seeded historical BMKG data'
        );
    }

    generate(count: number, options: GenerateOptions = {}): GenerateResult {
        const result: GenerateResult = { events: [], warnings: [] };

        for (let i = 0; i < count; i++) {
            const { event, region } = this.buildEvent(this.clock(), { forceTsunami: options.forceTsunami });
            this.store.addEvents([event]);
            result.events.push(event);
            this.logger.info(
                {
                    event_id: event.event_id,
                    magnitude: event.magnitude,
                    depth_km: event.depth_km,
                    region_name: event.region_name,
                    potential_tsunami: event.potential_tsunami,
                },
                'Generated seismic event'
            );

            if (!event.potential_tsunami) continue;

            if (this.config.warningLagMs === 0) {
                result.warnings.push(this.issueWarning(event, region));
            } else {
                this.scheduleWarning(event, region);
            }
        }

        return result;
    }

    start(): void {
        if (this.config.eventIntervalMs === 0 || this.interval) return;
        this.interval = setInterval(() => {
            try {
                this.generate(1);
            } catch (error) {
                this.logger.error({ err: error }, 'Seismic event generation failed');
            }
        }, this.config.eventIntervalMs);
        this.interval.unref();
        this.logger.info({ interval_ms: this.config.eventIntervalMs }, 'Seismic event generator started');
    }

    stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
        for (const timer of this.lagTimers) clearTimeout(timer);
        this.lagTimers.clear();
    }

    get pendingWarnings(): number {
        return this.lagTimers.size;
    }

    private scheduleWarning(event: SeismicEvent, region: SeismicRegion): void {
        const timer = setTimeout(() => {
            this.lagTimers.delete(timer);
            this.issueWarning(event, region);
        }, this.config.warningLagMs);
        timer.unref();
        this.lagTimers.add(timer);
    }

    private issueWarning(event: SeismicEvent, region: SeismicRegion): TsunamiWarning {
        const warning = this.buildWarning(event, region, this.clock());
        this.store.addWarnings([warning]);
        this.logger.info(
            {
                warning_id: warning.warning_id,
                related_event_id: warning.related_event_id,
                threat_level: warning.threat_level,
            },
            'Issued tsunami warning'
        );
        return warning;
    }

    private buildEvent(occurredAtMs: number, spec: EventSpec): { event: SeismicEvent; region: SeismicRegion } {
        const region = spec.regionName
            ? findRegion(spec.regionName)
            : this.faker.helpers.arrayElement(spec.forceTsunami ? SEA_REGIONS : SEISMIC_REGIONS);
        const magnitude = spec.magnitude ?? (spec.forceTsunami ? this.tenths(6.5, 7.9) : this.randomMagnitude());
        const depthKm = spec.depthKm ?? (spec.forceTsunami ? this.tenths(5, 70) : this.randomDepth());

        const event: SeismicEvent = {
            event_id: this.newEventId(occurredAtMs),
            magnitude,
            depth_km: depthKm,
            epicenter_lat: this.jitter(region.lat, region.spread),
            epicenter_lon: this.jitter(region.lon, region.spread),
            region_name: region.name,
            occurred_at: new Date(occurredAtMs).toISOString(),
            potential_tsunami: isTsunamiPotential(magnitude, depthKm, region),
        };
        return { event, region };
    }

    private buildWarning(event: SeismicEvent, region: SeismicRegion, issuedAtMs: number): TsunamiWarning {
        const arrivalMs = Date.parse(event.occurred_at) + this.faker.number.int({ min: 10, max: 60 }) * MINUTE_MS;
        return {
            warning_id: event.event_id.replace(/^EQ-/, 'TW-'),
            related_event_id: event.event_id,
            threat_level: threatLevelFor(event.magnitude),
            affected_zones: this.faker.helpers.arrayElements(region.affectedZones, { min: 1, max: 3 }),
            estimated_arrival: new Date(arrivalMs).toISOString(),
            issued_at: new Date(issuedAtMs).toISOString(),
        };
    }

    // EQ-<yyyyMMddHHmmss>-<6 hex>
    private newEventId(occurredAtMs: number): string {
        const stamp = new Date(occurredAtMs).toISOString().replace(/[-:T]/g, '').slice(0, 14);
        let id: string;
        do {
            id = `EQ-${stamp}-${this.faker.string.hexadecimal({ length: 6, casing: 'lower', prefix: '' })}`;
        } while (this.store.hasEvent(id));
        return id;
    }

    // < 5.0, 5.0–6.4 and >= 6.5
    private randomMagnitude(): number {
        const [min, max] = this.faker.helpers.weightedArrayElement([
            { weight: 55, value: [2.5, 4.9] },
            { weight: 30, value: [5.0, 6.4] },
            { weight: 15, value: [6.5, 7.9] },
        ]);
        return this.tenths(min, max);
    }

    // mostly shallow, with a tail of intermediate and deep events
    private randomDepth(): number {
        const [min, max] = this.faker.helpers.weightedArrayElement([
            { weight: 60, value: [5, 70] },
            { weight: 30, value: [70.1, 150] },
            { weight: 10, value: [150.1, 300] },
        ]);
        return this.tenths(min, max);
    }

    // random value in [min, max] with exactly one decimal
    private tenths(min: number, max: number): number {
        return this.faker.number.float({ min, max, fractionDigits: 1 });
    }

    // centre ± spread degrees, 2 decimals
    private jitter(centre: number, spread: number): number {
        return this.faker.number.float({ min: centre - spread, max: centre + spread, fractionDigits: 2 });
    }
}
