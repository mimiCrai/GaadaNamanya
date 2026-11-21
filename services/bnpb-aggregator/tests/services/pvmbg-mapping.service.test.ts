import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { metricsRegistry } from '../../src/libs/metrics';
import { BUILTIN_MAPPING, mapVolcanicReport, parseMappingFile } from '../../src/libs/pvmbg-mapping';
import { isSupersededVersion } from '../../src/repositories/hazard-event.repository';
import { pvmbgVersion } from '../../src/services/hazard-event-ingestion.service';
import { PvmbgMappingService } from '../../src/services/pvmbg-mapping.service';

const CONFIG = path.join(__dirname, '../../config/pvmbg-mapping');
const leadership = { instanceId: 'replica-1' } as never;
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

async function reloadFailures(): Promise<number> {
    const metric = await metricsRegistry.getSingleMetric('bnpb_aggregator_pvmbg_mapping_reload_failures_total')!.get();
    return metric.values[0]?.value ?? 0;
}

describe('PvmbgMappingService (hot reload by content hash, D-36)', () => {
    let dir: string;
    let file: string;
    let service: PvmbgMappingService;

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'pvmbg-mapping-'));
        file = path.join(dir, 'mapping.json');
        service = new PvmbgMappingService(leadership).useFile(file, 50);
    });
    afterEach(() => {
        service.stop();
        rmSync(dir, { recursive: true, force: true });
    });

    it('starts on the builtin M1 mapping and reports a missing file without crashing', async () => {
        expect(await service.checkNow()).toBe(false);
        const status = service.status();
        expect(status.source).toBe('builtin');
        expect(status.hash).toBe(BUILTIN_MAPPING.hash);
        expect(status.last_error).toMatch(/mapping tidak bisa dibaca/);
        expect(status.instance_id).toBe('replica-1');
    });

    it('loads a valid file and exposes the sha256 of its bytes', async () => {
        const text = readFileSync(path.join(CONFIG, 'examples/m2-adjusted.json'));
        writeFileSync(file, text);
        expect(await service.checkNow()).toBe(true);
        expect(service.status()).toEqual(
            expect.objectContaining({ hash: sha(text), label: 'm2-adjusted', source: 'file', last_error: null })
        );
        expect(await service.checkNow()).toBe(false);
    });

    it('keeps the previous mapping when the new file is invalid, counts the failure once, then recovers', async () => {
        const good = readFileSync(path.join(CONFIG, 'mapping.json'));
        writeFileSync(file, good);
        await service.checkNow();
        const before = await reloadFailures();

        writeFileSync(file, '{"label":"broken","required":["volcano_id"]}');
        expect(await service.checkNow()).toBe(false);
        expect(await service.checkNow()).toBe(false);
        expect(service.status().hash).toBe(sha(good));
        expect(service.status().last_error).toMatch(/'report_id' harus tetap wajib/);
        expect((await reloadFailures()) - before).toBe(1);

        writeFileSync(file, '{ not json');
        expect(await service.checkNow()).toBe(false);
        expect(service.status().last_error).toMatch(/bukan JSON valid/);

        const adjusted = readFileSync(path.join(CONFIG, 'examples/m2-adjusted.json'));
        writeFileSync(file, adjusted);
        expect(await service.checkNow()).toBe(true);
        expect(service.status()).toEqual(expect.objectContaining({ hash: sha(adjusted), last_error: null }));
    });

    it('picks up a change through the polling timer', async () => {
        // wait for a condition, not a fixed delay: timers run late when the whole suite runs in parallel
        const waitForLabel = async (label: string) => {
            const deadline = Date.now() + 5_000;
            while (service.active().label !== label && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return service.active().label;
        };
        writeFileSync(file, readFileSync(path.join(CONFIG, 'mapping.json')));
        service.start();
        expect(await waitForLabel('m1-contract')).toBe('m1-contract');
        writeFileSync(file, readFileSync(path.join(CONFIG, 'examples/m2-adjusted.json')));
        expect(await waitForLabel('m2-adjusted')).toBe('m2-adjusted');
    });
});

describe('mapping does not change normal v1/v2 records', () => {
    const v1 = {
        report_id: 'VR-1',
        volcano_id: 'SEMERU',
        alert_level: 'Waspada',
        eruption_count_24h: 2,
        ash_column_height_m: 300,
        reported_at: '2026-11-20T10:00:00.000Z',
    };
    const v2 = { ...v1, report_id: 'VR-2', confidence_level: 0.91 };

    it.each([
        ['default file', 'mapping.json'],
        ['adjusted file', 'examples/m2-adjusted.json'],
    ])('the %s maps v1 and v2 exactly like the builtin M1 contract', (_name, relative) => {
        const mapping = parseMappingFile(readFileSync(path.join(CONFIG, relative)));
        for (const record of [v1, v2]) {
            expect(mapVolcanicReport(record, mapping)).toEqual(mapVolcanicReport(record, BUILTIN_MAPPING));
        }
    });
});

describe('PVMBG version guard (D-30/D-32, rule 9b)', () => {
    const at = (iso: string) => new Date(iso);
    const v3 = pvmbgVersion(at('2026-11-20T10:03:00.000Z'), { seq: 3, index: 0 });
    const v5 = pvmbgVersion(at('2026-11-20T10:05:00.000Z'), { seq: 5, index: 0 });

    it('stored v5, incoming v3 → skipped (superseded)', () => {
        expect(isSupersededVersion(v5, v3)).toBe(true);
    });

    it('stored v5, incoming v5 again → applied as an idempotent no-op (not superseded)', () => {
        expect(isSupersededVersion(v5, v5)).toBe(false);
    });

    it('same reported_at: the later receive (seq, then index) wins, without any clock', () => {
        const t = at('2026-11-20T10:05:00.000Z');
        expect(isSupersededVersion(pvmbgVersion(t, { seq: 9, index: 0 }), pvmbgVersion(t, { seq: 8, index: 7 }))).toBe(true);
        expect(isSupersededVersion(pvmbgVersion(t, { seq: 9, index: 1 }), pvmbgVersion(t, { seq: 9, index: 2 }))).toBe(false);
    });
});
