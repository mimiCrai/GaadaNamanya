import 'reflect-metadata';
import { isDeepStrictEqual } from 'node:util';
import { BUILTIN_MAPPING, mapVolcanicReport } from '../../src/libs/pvmbg-mapping';

// D-35(a): null is accepted and carried as-is, so a re-delivered identical report maps to identical content
const report = {
    report_id: 'VR-20261120100000-a1b2c3',
    volcano_id: 'MERAPI',
    alert_level: 'Siaga',
    eruption_count_24h: 4,
    ash_column_height_m: 1200.5,
    reported_at: '2026-11-20T10:00:00.000Z',
};

describe('confidence_level null (D-9 audit)', () => {
    it('maps the same null report to the same attributes, so hasSameContent sees no change (no false hazard.updated)', () => {
        const first = mapVolcanicReport({ ...report, confidence_level: null }, BUILTIN_MAPPING);
        const again = mapVolcanicReport({ ...report, confidence_level: null }, BUILTIN_MAPPING);
        expect(isDeepStrictEqual(first.attributes, again.attributes)).toBe(true);
    });

    it('keeps v1 records (field absent) unchanged: no confidence_level is invented', () => {
        expect(mapVolcanicReport(report, BUILTIN_MAPPING).attributes).not.toHaveProperty('confidence_level');
    });
});
