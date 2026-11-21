import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SourceStream as Stream, SourceSyncStatus } from '../../src/db/schema/source-sync-states';
import { ProcessingError } from '../../src/libs/processing-error';
import { BUILTIN_MAPPING, CompiledMapping, mapVolcanicReport, parseMappingFile } from '../../src/libs/pvmbg-mapping';
import { decodeJson, payloadTooLarge, readLimited, splitRecords } from '../../src/libs/safe-decode';
import { PvmbgBodyFailureService } from '../../src/services/pvmbg-body-failure.service';
import { fieldReportConflictError } from '../../src/libs/field-report';
import env from '../../src/util/env';

// One test per row of docs/orang-c/SCHEMA_POLICY.md § 2; the test name is the row id.
const ADJUSTED = parseMappingFile(
    readFileSync(path.join(__dirname, '../../config/pvmbg-mapping/examples/m2-adjusted.json'))
);
const SourceStatus = {
    sourceStream: Stream.PvmbgVolcanic,
    status: SourceSyncStatus.Stale,
    lastSuccessfulPollAt: null,
    lastAttemptAt: null,
    staleSince: null,
    lastError: null,
    consecutiveFailures: 0,
};
const v1 = {
    report_id: 'VR-20261120100000-a1b2c3',
    volcano_id: 'MERAPI',
    alert_level: 'Siaga',
    eruption_count_24h: 4,
    ash_column_height_m: 1200.5,
    reported_at: '2026-11-20T10:00:00.000Z',
};

function failure(run: () => unknown): ProcessingError {
    try {
        run();
    } catch (error) {
        if (error instanceof ProcessingError) return error;
        throw error;
    }
    throw new Error('expected a ProcessingError');
}
const map = (value: unknown, mapping: CompiledMapping = BUILTIN_MAPPING) => mapVolcanicReport(value, mapping);
const decode = (text: string | Buffer) => decodeJson(Buffer.isBuffer(text) ? text : Buffer.from(text), { maxDepth: 64 });

describe('SCHEMA_POLICY declaration table', () => {
    it('SCHEMA_POLICY#additive_optional_field: accepted automatically, kept in attributes', () => {
        const mapped = map({ ...v1, confidence_level: 0.8, observer: 'Pos Babadan' });
        expect(mapped.attributes).toEqual({
            eruption_count_24h: 4,
            ash_column_height_m: 1200.5,
            confidence_level: 0.8,
            observer: 'Pos Babadan',
        });
    });

    it('SCHEMA_POLICY#field_order_changed: accepted automatically, same result', () => {
        const reversed = Object.fromEntries(Object.entries(v1).reverse());
        expect(map(reversed).report).toEqual(map(v1).report);
        expect(map(reversed).attributes).toEqual(map(v1).attributes);
    });

    it('SCHEMA_POLICY#optional_field_null_or_missing: confidence_level null or absent is accepted, value kept as received', () => {
        expect(map(v1).attributes).not.toHaveProperty('confidence_level');
        expect(map({ ...v1, confidence_level: null }).attributes.confidence_level).toBeNull();
    });

    it('SCHEMA_POLICY#rename_mapped_field: parked schema_incompatible, recovered by an alias', () => {
        const { alert_level, ...rest } = v1;
        const renamed = { ...rest, level: alert_level };
        const error = failure(() => map(renamed));
        expect(error.reason).toBe(
            "schema_incompatible: field wajib 'alert_level' hilang (kemungkinan di-rename menjadi 'level')"
        );
        expect(error.retryable).toBe(false);
        expect(map(renamed, ADJUSTED).report.alert_level).toBe('Siaga');
        expect(map(renamed, ADJUSTED).attributes).not.toHaveProperty('level');
    });

    it('SCHEMA_POLICY#type_change_mapped_field: parked schema_incompatible, recovered by a coercion table', () => {
        const typed = { ...v1, alert_level: 2 };
        const error = failure(() => map(typed));
        expect(error.reason).toBe(
            "schema_incompatible: field 'alert_level' berubah dari string (enum Normal|Waspada|Siaga|Awas) menjadi number"
        );
        expect(error.retryable).toBe(false);
        expect(map(typed, ADJUSTED).report.alert_level).toBe('Siaga');
        // string → integer coercion of eruption_count_24h, declared in the same row
        expect(failure(() => map({ ...v1, eruption_count_24h: '4' })).reason).toBe(
            "schema_incompatible: field 'eruption_count_24h' berubah dari number menjadi string"
        );
        expect(map({ ...v1, eruption_count_24h: '4' }, ADJUSTED).attributes.eruption_count_24h).toBe(4);
        expect(failure(() => map({ ...v1, alert_level: 7 }, ADJUSTED)).reason).toBe(
            "validation_failed: field 'alert_level' bernilai 7 tidak ada di tabel koersi mapping 'm2-adjusted'"
        );
    });

    it('SCHEMA_POLICY#missing_required_tolerable: parked schema_incompatible, recovered by dropping it from required', () => {
        const { eruption_count_24h: _dropped, ...missing } = v1;
        const error = failure(() => map({ ...missing, confidence_level: 0.7 }));
        expect(error.reason).toBe("schema_incompatible: field wajib 'eruption_count_24h' hilang");
        expect(error.retryable).toBe(false);
        expect(map(missing, ADJUSTED).attributes).toEqual({ ash_column_height_m: 1200.5 });
    });

    it('SCHEMA_POLICY#missing_required_report_id: parked, not recoverable without a code change', () => {
        const { report_id: _dropped, ...missing } = v1;
        const error = failure(() => map(missing));
        expect(error.reason).toBe("schema_incompatible: field wajib 'report_id' hilang");
        expect(failure(() => map(missing, ADJUSTED)).reason).toBe(error.reason);
        expect(() =>
            parseMappingFile(Buffer.from(JSON.stringify({ required: ['volcano_id', 'alert_level', 'reported_at'] })))
        ).toThrow("'report_id' harus tetap wajib");
    });

    it('SCHEMA_POLICY#unknown_enum_value: parked validation_failed, recoverable by a value table', () => {
        const unknown = { ...v1, alert_level: 'Bahaya' };
        const error = failure(() => map(unknown));
        expect(error.reason).toBe(
            'validation_failed: field \'alert_level\' bernilai "Bahaya" di luar nilai yang dikenal (Normal|Waspada|Siaga|Awas)'
        );
        expect(error.retryable).toBe(false);
        const valueTable = parseMappingFile(
            Buffer.from(
                JSON.stringify({ label: 'enum-v3', coercions: { alert_level: { from: 'string', table: { Bahaya: 'Awas' } } } })
            )
        );
        expect(map(unknown, valueTable).report.alert_level).toBe('Awas');
    });

    it('SCHEMA_POLICY#unknown_volcano_id: parked validation_failed, a new volcano needs reference data (code)', () => {
        const error = failure(() => map({ ...v1, volcano_id: 'GUNUNG_FIKTIF' }));
        expect(error.reason).toBe("validation_failed: volcano_id 'GUNUNG_FIKTIF' tidak ada di tabel referensi BNPB");
        expect(error.retryable).toBe(false);
        expect(failure(() => map({ ...v1, volcano_id: 'GUNUNG_FIKTIF' }, ADJUSTED)).reason).toBe(error.reason);
        // a renamed code of a known volcano can be mapped back with a value table
        const renamedCode = parseMappingFile(
            Buffer.from(JSON.stringify({ coercions: { volcano_id: { from: 'string', table: { MRP: 'MERAPI' } } } }))
        );
        expect(map({ ...v1, volcano_id: 'MRP' }, renamedCode).location.areaName).toBe('Gunung Merapi');
    });

    it('SCHEMA_POLICY#reported_at_not_iso: parked validation_failed, not recoverable by config', () => {
        const error = failure(() => map({ ...v1, reported_at: '20/11/2026 10:00' }));
        expect(error.reason).toBe("validation_failed: field 'reported_at' tidak sesuai format datetime");
        expect(failure(() => map({ ...v1, reported_at: '20/11/2026 10:00' }, ADJUSTED)).reason).toBe(error.reason);
    });

    it('SCHEMA_POLICY#envelope_not_array: whole body parked schema_incompatible', () => {
        const body = Buffer.from('{"reports":[]}');
        const error = failure(() => splitRecords(body, decode(body)));
        expect(error.reason).toBe("schema_incompatible: respons harus berupa array atau objek dengan array 'data'");
        expect(error.retryable).toBe(false);
    });

    it('SCHEMA_POLICY#canonical_and_alias_both_present: canonical wins, alias kept in attributes, warning raised', () => {
        const conflicts: string[] = [];
        const mapped = mapVolcanicReport({ ...v1, level: 'Awas' }, ADJUSTED, (field, alias) =>
            conflicts.push(`${field}<-${alias}`)
        );
        expect(mapped.report.alert_level).toBe('Siaga');
        expect(mapped.attributes.level).toBe('Awas');
        expect(conflicts).toEqual(['alert_level<-level']);
    });

    it('SCHEMA_POLICY#report_id_conflict: same field report id with a different body is parked as conflict', () => {
        const error = fieldReportConflictError('3f1d2c9a-0000-4000-8000-000000000001', 'a'.repeat(64), 'b'.repeat(64));
        expect(error.category).toBe('conflict');
        expect(error.retryable).toBe(false);
        expect(error.reason).toBe(
            `conflict: report_id 3f1d2c9a-0000-4000-8000-000000000001 sudah ada dengan isi berbeda (sha256 ${'a'.repeat(64)} vs ${'b'.repeat(64)})`
        );
    });

    it('SCHEMA_POLICY#malformed_truncated: whole body parked malformed_json', () => {
        const error = failure(() => decode('{"data":[{"report_id":"VR-1","volcano_id":"MER'));
        expect(error.reason).toMatch(/^malformed_json: JSON terpotong \(/);
        expect(error.retryable).toBe(false);
    });

    it('SCHEMA_POLICY#malformed_deep_nesting: whole body parked nesting_too_deep, never parsed', () => {
        const error = failure(() => decode(`{"data":${'['.repeat(10_000)}${']'.repeat(10_000)}}`));
        expect(error.reason).toBe('nesting_too_deep: kedalaman nesting melebihi 64 pada offset 71');
        expect(error.retryable).toBe(false);
    });

    it('SCHEMA_POLICY#malformed_invalid_utf8: whole body parked invalid_utf8', () => {
        const body = Buffer.concat([Buffer.from('{"data":[],"meta":{"note":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}}')]);
        const error = failure(() => decode(body));
        expect(error.reason).toBe('invalid_utf8: byte UTF-8 tidak valid pada offset 27');
        expect(error.retryable).toBe(false);
    });

    it('SCHEMA_POLICY#malformed_oversized: whole body parked payload_too_large, read within the byte limit', async () => {
        async function* stream() {
            for (let i = 0; i < 8; i++) yield Buffer.alloc(1024 * 1024, 0x20);
        }
        const read = await readLimited(stream(), 5 * 1024 * 1024);
        expect(read.kind).toBe('overflow');
        const error = payloadTooLarge(read.size, 5 * 1024 * 1024);
        expect(error.reason).toBe('payload_too_large: ukuran 8388608 byte melebihi batas 5242880 byte');
        expect(error.retryable).toBe(false);
    });

    it('SCHEMA_POLICY#body_failure_window_skipped: K consecutive broken bodies advance and park the window', async () => {
        const recorded: { reason: string; retryable: boolean }[] = [];
        const service = new PvmbgBodyFailureService(
            {
                getState: async () => ({ ...SourceStatus, consecutiveBodyFailures: env.PVMBG_BODY_FAILURE_HOLD_POLLS - 1 }),
                recordHeldBodyFailure: async () => 0,
            } as never,
            {
                record: async (input: { error: ProcessingError }) => {
                    recorded.push({ reason: input.error.reason, retryable: input.error.retryable });
                    return { messageId: 'msg-1', created: true, reopened: false, status: 'parked' };
                },
            } as never
        );
        const since = new Date('2026-11-20T10:00:00.000Z');
        const until = new Date('2026-11-20T10:00:15.000Z');
        await service.onBodyFailure(new ProcessingError('malformed_json', 'JSON terpotong'), { since, until, correlationId: 'c' }, {
            ownerId: 'o',
            epoch: 1,
        });
        expect(recorded).toEqual([
            {
                reason: `window_skipped: jendela poll [2026-11-20T10:00:00.000Z, 2026-11-20T10:00:15.000Z) dilewati setelah ${env.PVMBG_BODY_FAILURE_HOLD_POLLS} body rusak berturut-turut; isi ulang manual dengan since=2026-11-20T10:00:00.000Z`,
                retryable: false,
            },
        ]);
    });
});
