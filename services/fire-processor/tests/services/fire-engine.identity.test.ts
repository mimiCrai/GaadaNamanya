import { parseDecimal } from '../../src/libs/decimal';
import { FireEngine } from '../../src/services/fire-engine.service';
import { EngineSnapshot } from '../../src/types/fire';
import { severityOf } from '../../src/libs/hazard-mapper';
import { fireIdFor } from '../../src/libs/fire-registry';
import { Det, keyOf, LogBuilder } from '../helpers/fire-log';

const LON = '113.80000';
const at = (lat: string, time: number, extra: Partial<Det> = {}): Det => ({ lat, lon: LON, time, ...extra });

function run(log: LogBuilder) {
    const engine = new FireEngine(120 * 60_000);
    const results = log.records.map((record) => engine.process(record));
    return { engine, results, hazards: engine.hazards() };
}

describe('fire identity', () => {
    it('derives source_ref_id from sha256 of the anchor key', () => {
        const a = at('-2.50000', 100);
        const { hazards } = run(new LogBuilder().detection(a).detection(at('-2.50800', 200)));
        expect(hazards[0].source_ref_id).toBe(fireIdFor(keyOf(a)));
        expect(hazards[0].source_ref_id).toMatch(/^fire-[0-9a-f]{12}$/);
    });

    it('keeps the fire with the smaller anchor on merge and deletes the other', () => {
        const p = [at('-2.50000', 500), at('-2.50800', 500)];
        const q = [at('-2.52000', 300), at('-2.52800', 300)];
        const bridge = at('-2.51400', 400);
        const { results, hazards } = run(
            new LogBuilder().detection(p[0]).detection(p[1]).detection(q[0]).detection(q[1]).detection(bridge)
        );
        const fireP = fireIdFor(keyOf(p[0]));
        const fireQ = fireIdFor(keyOf(q[0]));
        expect(results[4].changes).toEqual([
            { op: 'delete', id: fireP, version: 4, reason: 'merged' },
            { op: 'upsert', id: fireQ, version: 4 },
        ]);
        expect(hazards.map((h) => h.source_ref_id)).toEqual([fireQ]);
        expect(hazards[0].attributes.detection_count).toBe(5);
    });

    it('does not change the id when an earlier detection joins (anchor frozen at birth)', () => {
        const b = at('-2.50800', 300);
        const { results, hazards } = run(
            new LogBuilder().detection(b).detection(at('-2.51600', 300)).detection(at('-2.50000', 100))
        );
        expect(results[2].changes).toEqual([{ op: 'upsert', id: fireIdFor(keyOf(b)), version: 2 }]);
        expect(hazards[0].occurred_at).toBe('2026-11-15T01:00:00Z');
    });

    it('DECISIONS example: {A,B,C} anchor A, B retracted, then D (near C) low → n gets a new id from min(C,D)', () => {
        const [A, B, C] = [at('-2.50000', 100), at('-2.50800', 200), at('-2.51600', 300)];
        const D = at('-2.52400', 400, { conf: 'l' });
        const { results, hazards } = run(
            new LogBuilder()
                .detection(A)
                .detection(B)
                .detection(C)
                .detection(D)
                .retract(B)
                .update({ ...D, conf: 'n' })
        );
        expect(results[4].changes).toEqual([
            { op: 'delete', id: fireIdFor(keyOf(A)), version: 4, reason: 'dissolved' },
        ]);
        expect(results[5].changes).toEqual([{ op: 'upsert', id: fireIdFor(keyOf(C)), version: 5 }]);
        expect(hazards.map((h) => h.source_ref_id)).toEqual([fireIdFor(keyOf(C))]);
    });

    it('keeps the id on the fire-sized piece when the anchor piece becomes a single detection', () => {
        const [A, B, C, D] = [at('-2.50000', 100), at('-2.50800', 200), at('-2.51600', 300), at('-2.52400', 400)];
        const { results } = run(new LogBuilder().detection(A).detection(B).detection(C).detection(D).retract(B));
        expect(results[4].changes).toEqual([{ op: 'upsert', id: fireIdFor(keyOf(A)), version: 4 }]);
    });

    it('splits into the anchor piece (same id) and a new fire for the other piece', () => {
        const [A1, A2, X, B1, B2] = [
            at('-2.50000', 100),
            at('-2.50800', 200),
            at('-2.51600', 300),
            at('-2.52400', 400),
            at('-2.53200', 500),
        ];
        const { results, hazards } = run(
            new LogBuilder().detection(A1).detection(A2).detection(X).detection(B1).detection(B2).retract(X)
        );
        expect(results[5].changes).toEqual(
            [
                { op: 'upsert', id: fireIdFor(keyOf(A1)), version: 5 },
                { op: 'upsert', id: fireIdFor(keyOf(B1)), version: 5 },
            ].sort((a, b) => (a.id < b.id ? -1 : 1))
        );
        expect(hazards).toHaveLength(2);
    });
});

describe('determinism', () => {
    const log = new LogBuilder()
        .heartbeat('2026-11-15T06:00:00Z')
        .detection(at('-2.50000', 500, { frp: '0.1', sat: 'N21' }))
        .detection(at('-2.50800', 510, { frp: '0.2', conf: 'h' }))
        .detection(at('-2.51600', 520, { frp: '11.71' }))
        .detection(at('-2.52400', 530, { conf: 'l' }))
        .unprocessed()
        .detection(at('-2.60000', 300, { frp: '3.333' }))
        .detection(at('-2.60700', 310, { frp: '1.10', sat: 'N' }))
        .update(at('-2.52400', 530, { conf: 'n', frp: '2.5' }))
        .detection(at('-2.50800', 510, { frp: '0.2', conf: 'h' }))
        .retract(at('-2.50800', 510))
        .heartbeat('2026-11-15T09:00:00Z')
        .detection(at('-2.55000', 100))
        .detection(at('-2.59300', 600))
        .update(at('-2.60000', 300, { frp: '40' }));

    const finalState = (engine: FireEngine) =>
        JSON.stringify({ hazards: engine.hazards(), snapshot: engine.snapshot() });

    it('produces identical output for the same log, including exact FRP sums and centroids', () => {
        const first = run(log);
        const second = run(log);
        expect(finalState(first.engine)).toBe(finalState(second.engine));
        const total = run(
            new LogBuilder()
                .detection(at('-2.50000', 500, { frp: '0.1' }))
                .detection(at('-2.50800', 500, { frp: '0.2' }))
        );
        expect(total.hazards[0].attributes.total_frp_mw).toBe(0.3);
        expect(total.hazards[0].latitude).toBe(-2.504);
    });

    it('produces identical output and changes after a snapshot + restore at every cut point', () => {
        const reference = run(log);
        for (let cut = 0; cut <= log.records.length; cut++) {
            const head = new FireEngine(120 * 60_000);
            log.records.slice(0, cut).forEach((record) => head.process(record));
            const stored = JSON.parse(JSON.stringify(head.snapshot())) as EngineSnapshot;
            const { engine } = FireEngine.restore(stored);
            const tailChanges = log.records.slice(cut).map((record) => engine.process(record).changes);
            expect(tailChanges).toEqual(reference.results.slice(cut).map((result) => result.changes));
            expect(finalState(engine)).toBe(finalState(reference.engine));
        }
    });
});

describe('HazardEvent mapping', () => {
    const d = (t: string) => parseDecimal(t)!;

    it.each([
        [5, '29.99', 'WASPADA'],
        [6, '0', 'SIAGA'],
        [5, '30', 'SIAGA'],
        [5, '30.00', 'SIAGA'],
        [19, '99.99', 'SIAGA'],
        [20, '0', 'AWAS'],
        [2, '100', 'AWAS'],
        [2, '100.00', 'AWAS'],
    ])('severity for %i detections and %s MW is %s', (count, frp, expected) => {
        expect(severityOf(count, d(frp))).toBe(expected);
    });

    it('has the same JSON shape as the Lampiran A example', () => {
        const example = JSON.parse(
            '{"hazard_id":"hz-7f3a91","source":"SATELIT","source_ref_id":"fire-0a41c7","hazard_type":"WILDFIRE",' +
                '"severity":"SIAGA","area_name":"Kalimantan Tengah","latitude":-2.51234,"longitude":113.80450,' +
                '"occurred_at":"2026-11-12T02:43:00Z","ingested_at":"2026-11-12T02:51:08Z",' +
                '"attributes":{"detection_count":6,"satellites":["N20","N21"],"max_confidence":"h",' +
                '"total_frp_mw":41.45,"detection_keys":["N20|2026-11-12|243|-2.51230|113.80440"]}}'
        ) as Record<string, unknown>;
        const { hazards } = run(
            new LogBuilder()
                .detection({
                    sat: 'N20',
                    date: '2026-11-12',
                    time: 243,
                    lat: '-2.51230',
                    lon: '113.80440',
                    conf: 'h',
                    frp: '20.00',
                })
                .detection({
                    sat: 'N21',
                    date: '2026-11-12',
                    time: 250,
                    lat: '-2.51238',
                    lon: '113.80460',
                    frp: '21.45',
                })
        );
        const hazard = hazards[0] as unknown as Record<string, unknown>;
        const withStoreFields = { hazard_id: 'x', ...hazard, ingested_at: 'x' };
        const order = (o: Record<string, unknown>) => Object.keys(o).sort();
        expect(order(withStoreFields)).toEqual(order(example));
        expect(Object.keys(hazard.attributes as object)).toEqual(Object.keys(example.attributes as object));
        for (const key of Object.keys(hazard)) expect(typeof hazard[key]).toBe(typeof example[key]);
        expect(hazard).toMatchObject({
            source: 'SATELIT',
            hazard_type: 'WILDFIRE',
            severity: 'SIAGA',
            area_name: 'Kalimantan Tengah',
            latitude: -2.51234,
            longitude: 113.8045,
            occurred_at: '2026-11-12T02:43:00Z',
            attributes: {
                detection_count: 2,
                satellites: ['N20', 'N21'],
                max_confidence: 'h',
                total_frp_mw: 41.45,
                detection_keys: ['N20|2026-11-12|243|-2.51230|113.80440', 'N21|2026-11-12|250|-2.51238|113.80460'],
            },
        });
    });
});
