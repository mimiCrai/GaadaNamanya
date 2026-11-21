import { EARTH_RADIUS_KM } from '../../src/constants/fire';
import { cellHeightKm, cellWidthKm, haversineKm, lonRing, neighborCells } from '../../src/libs/geo';
import { FireEngine } from '../../src/services/fire-engine.service';
import { Det, keyOf, LogBuilder } from '../helpers/fire-log';

const LON = '113.80000';
const A: Det = { lat: '-2.50000', lon: LON };
const B: Det = { lat: '-2.50800', lon: LON };
const C: Det = { lat: '-2.51600', lon: LON };

function run(log: LogBuilder) {
    const engine = new FireEngine(120 * 60_000);
    const results = log.records.map((record) => engine.process(record));
    return { engine, results, hazards: engine.hazards() };
}

describe('Definisi Kebakaran', () => {
    it('chains A–B–C into one fire although A–C is farther than 1 km', () => {
        expect(haversineKm(-2.5, 113.8, -2.516, 113.8)).toBeGreaterThan(1);
        const { hazards, engine } = run(new LogBuilder().detection(A).detection(C).detection(B));
        expect(hazards).toHaveLength(1);
        expect(hazards[0].attributes.detection_keys).toEqual([keyOf(A), keyOf(B), keyOf(C)].sort());
        expect(engine.stats().single_detections).toBe(0);
    });

    it('treats exactly 1.0 km as connected (inclusive) and just beyond as not', () => {
        const oneKmDeg = 1 / ((EARTH_RADIUS_KM * Math.PI) / 180);
        const exact = { lat: String(oneKmDeg), lon: '110' };
        const beyond = { lat: String(oneKmDeg * 1.00001), lon: '110' };
        expect(haversineKm(0, 110, Number(exact.lat), 110)).toBeCloseTo(1, 12);

        expect(run(new LogBuilder().detection({ lat: '0', lon: '110' }).detection(exact)).hazards).toHaveLength(1);
        expect(run(new LogBuilder().detection({ lat: '0', lon: '110' }).detection(beyond)).hazards).toHaveLength(0);
    });

    it('treats exactly 360 minutes as connected (inclusive), also across midnight', () => {
        const at = (date: string, time: number): Det => ({ ...A, date, time });
        expect(
            run(new LogBuilder().detection(at('2026-11-15', 0)).detection(at('2026-11-15', 600))).hazards
        ).toHaveLength(1);
        expect(
            run(new LogBuilder().detection(at('2026-11-15', 0)).detection(at('2026-11-15', 601))).hazards
        ).toHaveLength(0);
        expect(
            run(new LogBuilder().detection(at('2026-11-14', 2100)).detection(at('2026-11-15', 300))).hazards
        ).toHaveLength(1);
    });

    it('merges detections from different satellites into one fire', () => {
        const { hazards } = run(new LogBuilder().detection({ ...A, sat: 'N21' }).detection({ ...B, sat: 'N20' }));
        expect(hazards).toHaveLength(1);
        expect(hazards[0].attributes.satellites).toEqual(['N20', 'N21']);
    });

    it('excludes low confidence detections and counts singles', () => {
        const { hazards, engine } = run(new LogBuilder().detection(A).detection({ ...B, conf: 'l' }));
        expect(hazards).toHaveLength(0);
        expect(engine.stats()).toMatchObject({ detections: 2, low_excluded: 1, single_detections: 1, fires: 0 });
    });

    it('counts a repeated detection once', () => {
        const { hazards, engine, results } = run(
            new LogBuilder()
                .detection(A)
                .detection(B)
                .detection({ ...B, frp: '99.00' })
        );
        expect(results[2].outcome).toBe('duplicate');
        expect(hazards[0].attributes.detection_count).toBe(2);
        expect(hazards[0].attributes.total_frp_mw).toBe(10);
        expect(engine.stats().counters.duplicates).toBe(1);
    });

    it('splits a fire when the bridging detection is retracted', () => {
        const { hazards, results, engine } = run(new LogBuilder().detection(A).detection(B).detection(C).retract(B));
        const fireId = results[1].changes[0].id;
        expect(results[3].changes).toEqual([{ op: 'delete', id: fireId, version: 3, reason: 'dissolved' }]);
        expect(hazards).toHaveLength(0);
        expect(engine.stats()).toMatchObject({ single_detections: 2, retracted: 1 });
    });

    it('treats an update to low as removal and back to n/h as addition', () => {
        const { results, hazards } = run(
            new LogBuilder()
                .detection(A)
                .detection(B)
                .update({ ...B, conf: 'l' })
                .update({ ...B, conf: 'h', frp: '7.25' })
        );
        const fireId = results[1].changes[0].id;
        expect(results[2].changes).toEqual([{ op: 'delete', id: fireId, version: 2, reason: 'dissolved' }]);
        expect(results[3].changes).toEqual([{ op: 'upsert', id: fireId, version: 3 }]);
        expect(hazards[0].attributes).toMatchObject({ max_confidence: 'h', total_frp_mw: 12.25 });
    });

    it('applies a retract sent with the full detection object', () => {
        const { hazards } = run(new LogBuilder().detection(A).detection(B).retractByDetection(B));
        expect(hazards).toHaveLength(0);
    });

    it('merges several components and singles through one bridging detection', () => {
        const at = (lat: string, lon: string): Det => ({ lat, lon });
        const log = new LogBuilder()
            .detection(at('-2.49200', LON))
            .detection(at('-2.48400', LON))
            .detection(at('-2.50000', '113.80800'))
            .detection(at('-2.50000', '113.79200'))
            .detection(at('-2.50000', LON));
        const { engine, hazards } = run(log);
        expect(hazards).toHaveLength(1);
        expect(hazards[0].attributes.detection_count).toBe(5);
        expect(engine.stats().single_detections).toBe(0);
        const { engine: rebuilt } = FireEngine.restore(JSON.parse(JSON.stringify(engine.snapshot())));
        expect(rebuilt.hazards()).toEqual(hazards);
        expect(rebuilt.stats()).toEqual(engine.stats());
    });

    it('keeps insertion into a dense cluster near-linear (1,600 detections within ~200 m)', () => {
        const log = new LogBuilder();
        for (let i = 0; i < 1600; i++) {
            const lat = (-2.5 - (i % 40) * 0.00004).toFixed(5);
            log.detection({ lat, lon: (113.8 + Math.floor(i / 40) * 0.00004).toFixed(5) });
        }
        const started = Date.now();
        const { hazards } = run(log);
        expect(hazards[0].attributes.detection_count).toBe(1600);
        expect(Date.now() - started).toBeLessThan(30_000);
    });
});

describe('spatial grid', () => {
    it('uses cells at least 1 km wide on both axes across Indonesia (6°N–11°S)', () => {
        expect(cellHeightKm()).toBeGreaterThanOrEqual(1);
        for (let lat = -11.5; lat <= 6.5; lat += 0.5) {
            expect(cellWidthKm(Math.abs(lat) + 0.02)).toBeGreaterThanOrEqual(1);
            expect(lonRing(lat)).toBe(1);
            expect(neighborCells(lat, 110)).toHaveLength(9);
        }
    });

    it('widens the longitude ring where cells get narrower than 1 km', () => {
        expect(lonRing(60)).toBe(2);
        const width = 0.999 / ((EARTH_RADIUS_KM * Math.PI) / 180) / Math.cos((60 * Math.PI) / 180);
        const { hazards } = run(
            new LogBuilder()
                .detection({ lat: '60', lon: '10.001' })
                .detection({ lat: '60', lon: String(10.001 + width) })
        );
        expect(hazards).toHaveLength(1);
    });
});
