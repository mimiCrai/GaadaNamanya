import { PVMBG_VOLCANIC_FIELDS, volcanicReportSchema } from '../../src/clients/pvmbg.schema';
import { ProcessingError } from '../../src/libs/processing-error';
import { validateRecord } from '../../src/libs/schema-validation';

const valid = {
    report_id: 'r-1',
    volcano_id: 'MERAPI',
    alert_level: 'Siaga',
    eruption_count_24h: 3,
    ash_column_height_m: 1200.5,
    reported_at: '2026-11-12T02:40:11Z',
};

function failure(value: unknown): ProcessingError {
    try {
        validateRecord(value, volcanicReportSchema, PVMBG_VOLCANIC_FIELDS);
    } catch (error) {
        return error as ProcessingError;
    }
    throw new Error('expected failure');
}

describe('validateRecord (PVMBG policy)', () => {
    it('accepts v1, v2 and unknown additive fields automatically', () => {
        expect(validateRecord(valid, volcanicReportSchema, PVMBG_VOLCANIC_FIELDS)).toEqual(valid);
        const additive = { ...valid, confidence_level: 0.8, observer: 'Pos Babadan' };
        expect(validateRecord(additive, volcanicReportSchema, PVMBG_VOLCANIC_FIELDS)).toEqual(additive);
    });

    it('reports a type change as schema_incompatible in Lampiran A wording', () => {
        const error = failure({ ...valid, eruption_count_24h: '3' });
        expect(error.category).toBe('schema_incompatible');
        expect(error.reason).toBe("schema_incompatible: field 'eruption_count_24h' berubah dari number menjadi string");
        expect(error.retryable).toBe(false);
    });

    it('reports a rename as a missing required field with the likely new name', () => {
        const { alert_level, ...rest } = valid;
        const error = failure({ ...rest, level: alert_level });
        expect(error.category).toBe('schema_incompatible');
        expect(error.detail).toBe("field wajib 'alert_level' hilang (kemungkinan di-rename menjadi 'level')");
    });

    it('reports a missing required field', () => {
        const { reported_at: _ignored, ...rest } = valid;
        expect(failure(rest).detail).toBe("field wajib 'reported_at' hilang");
    });

    it('reports out-of-contract values as validation_failed', () => {
        const error = failure({ ...valid, alert_level: 'Merah' });
        expect(error.category).toBe('validation_failed');
        expect(error.detail).toContain("'alert_level'");
        expect(failure({ ...valid, reported_at: 'kemarin' }).category).toBe('validation_failed');
        expect(failure({ ...valid, confidence_level: 1.5 }).category).toBe('validation_failed');
    });

    it('prefers shape errors over value errors and rejects non-objects', () => {
        expect(failure({ ...valid, alert_level: 'Merah', eruption_count_24h: null }).category).toBe(
            'schema_incompatible'
        );
        expect(failure([valid]).detail).toBe('record harus berupa objek, diterima array');
    });
});
