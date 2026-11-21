import { FireEngine } from '../../src/services/fire-engine.service';
import { fireIdFor } from '../../src/libs/fire-registry';
import { Det, keyOf, LogBuilder } from '../helpers/fire-log';

const LATENESS_MS = 120 * 60_000;
const LON = '113.80000';
const at = (lat: string, time: number, extra: Partial<Det> = {}): Det => ({ lat, lon: LON, time, ...extra });

function run(log: LogBuilder, engine = new FireEngine(LATENESS_MS)) {
    const results = log.records.map((record) => engine.process(record));
    return { engine, results };
}

describe('watermark and lateness', () => {
    it('reports a detection older than the watermark as late without applying it', () => {
        const late = at('-2.50000', 359);
        const { engine, results } = run(
            new LogBuilder().heartbeat('2026-11-15T06:00:00Z').detection(late).detection(at('-2.50800', 400))
        );
        expect(results[1]).toMatchObject({
            outcome: 'late',
            changes: [],
            late: {
                offset: 1,
                detection_key: keyOf(late),
                kind: 'detection',
                event_time: '2026-11-15T03:59:00Z',
                watermark: '2026-11-15T04:00:00Z',
                received_at: '2026-11-15T12:00:00.000Z',
            },
        });
        expect(engine.hazards()).toHaveLength(0);
        expect(engine.stats()).toMatchObject({ late_detections: 1, detections: 1, single_detections: 1 });
    });

    it('applies a detection exactly at the watermark', () => {
        const { results, engine } = run(
            new LogBuilder()
                .heartbeat('2026-11-15T06:00:00Z')
                .detection(at('-2.50000', 400))
                .detection(at('-2.50800', 400))
        );
        expect(results.map((r) => r.outcome)).toEqual(['heartbeat', 'applied', 'applied']);
        expect(engine.hazards()).toHaveLength(1);
    });

    it('lets a detection within the lateness bound merge two fires', () => {
        const p = [at('-2.50000', 500), at('-2.50800', 500)];
        const q = [at('-2.52000', 500, { sat: 'N21' }), at('-2.52800', 500, { sat: 'N21' })];
        const { results, engine } = run(
            new LogBuilder()
                .detection(p[0])
                .detection(p[1])
                .detection(q[0])
                .detection(q[1])
                .heartbeat('2026-11-15T07:00:00Z')
                .detection(at('-2.51400', 459))
                .detection(at('-2.51400', 500))
        );
        expect(results[5].outcome).toBe('late');
        expect(results[6].outcome).toBe('applied');
        expect(results[6].changes.map((c) => c.op)).toEqual(['delete', 'upsert']);
        expect(engine.hazards()).toHaveLength(1);
        expect(engine.hazards()[0].attributes.detection_count).toBe(5);
    });

    it('marks a fire final once watermark passes its last detection + 360 min, and still applies updates', () => {
        const a = at('-2.50000', 500);
        const log = new LogBuilder()
            .detection(a)
            .detection(at('-2.50800', 500))
            .heartbeat('2026-11-15T13:00:00Z')
            .heartbeat('2026-11-15T13:01:00Z')
            .update({ ...a, frp: '50.00' })
            .detection(at('-2.51600', 500));
        const engine = new FireEngine(LATENESS_MS);
        engine.process(log.records[0]);
        engine.process(log.records[1]);
        engine.process(log.records[2]);
        expect(engine.stats()).toMatchObject({ watermark: '2026-11-15T11:00:00Z', final_fires: 0 });
        engine.process(log.records[3]);
        expect(engine.stats()).toMatchObject({ watermark: '2026-11-15T11:01:00Z', final_fires: 1 });

        const update = engine.process(log.records[4]);
        expect(update.changes).toEqual([{ op: 'upsert', id: fireIdFor(keyOf(a)), version: 4 }]);
        expect(engine.hazards()[0]).toMatchObject({ severity: 'SIAGA', attributes: { total_frp_mw: 55 } });
        expect(engine.process(log.records[5]).outcome).toBe('late');
    });

    it('never moves the watermark backwards', () => {
        const { engine } = run(new LogBuilder().heartbeat('2026-11-15T10:00:00Z').heartbeat('2026-11-15T09:00:00Z'));
        expect(engine.stats()).toMatchObject({
            watermark: '2026-11-15T08:00:00Z',
            last_virtual_now: '2026-11-15T09:00:00Z',
        });
    });

    it('keeps updates of a late detection late and ignores its duplicates', () => {
        const late = at('-2.50000', 100);
        const { results } = run(
            new LogBuilder()
                .heartbeat('2026-11-15T06:00:00Z')
                .detection(late)
                .update({ ...late, conf: 'h' })
                .detection(late)
        );
        expect(results.map((r) => r.outcome)).toEqual(['heartbeat', 'late', 'late', 'duplicate']);
        expect(results[2].late?.kind).toBe('update');
    });

    it('skips records whose feed offset is not newer than the last processed one', () => {
        const log = new LogBuilder().detection(at('-2.50000', 100));
        const engine = new FireEngine(LATENESS_MS);
        expect(engine.process(log.records[0]).outcome).toBe('applied');
        expect(engine.process(log.records[0]).outcome).toBe('stale_offset');
        expect(engine.stats()).toMatchObject({ last_offset: 0, detections: 1 });
    });

    it('takes allowed_lateness from the snapshot, not from the new configuration', () => {
        const log = new LogBuilder()
            .detection(at('-3.00000', 100))
            .heartbeat('2026-11-15T06:00:00Z')
            .detection(at('-2.50000', 430));
        const head = new FireEngine(LATENESS_MS);
        head.process(log.records[0]);
        const { engine, latenessMismatch } = FireEngine.restore(JSON.parse(JSON.stringify(head.snapshot())), {
            configuredAllowedLatenessMs: 30 * 60_000,
        });
        expect(latenessMismatch).toBe(true);
        expect(engine.allowedLatenessMs).toBe(LATENESS_MS);
        engine.process(log.records[1]);
        expect(engine.process(log.records[2]).outcome).toBe('applied');

        const withNewConfig = new FireEngine(30 * 60_000);
        log.records.forEach((record) => withNewConfig.process(record));
        expect(withNewConfig.stats().late_detections).toBe(1);
    });
});
