import { compareDecimal, divideHalfEven, formatDecimal, parseDecimal, sumDecimals } from '../../src/libs/decimal';
import { detectionTimeMs, parseLogRecord } from '../../src/libs/feed-parser';
import { rawObjectMembers } from '../../src/libs/raw-json';
import { LogBuilder } from '../helpers/fire-log';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe('detection time from acq_date + acq_time (UTC, HHMM without leading zeros)', () => {
    it.each([
        ['5', '2026-11-15T00:05:00.000Z'],
        ['243', '2026-11-15T02:43:00.000Z'],
        ['1200', '2026-11-15T12:00:00.000Z'],
        ['0243', '2026-11-15T02:43:00.000Z'],
        ['2359', '2026-11-15T23:59:00.000Z'],
    ])('acq_time %s', (time, expected) => {
        expect(iso(detectionTimeMs('2026-11-15', time))).toBe(expected);
    });

    it.each(['2400', '260', '12345', '-5', '1.5'])('rejects acq_time %s', (time) => {
        expect(detectionTimeMs('2026-11-15', time)).toBeNull();
    });

    it('rejects impossible dates', () => {
        expect(detectionTimeMs('2026-02-30', '100')).toBeNull();
    });
});

describe('parseLogRecord', () => {
    it('builds the detection key from raw feed text without reformatting numbers', () => {
        const log = new LogBuilder().detection({ sat: 'N20', time: 243, lat: '-2.51230', lon: '113.80440' });
        const event = parseLogRecord(log.records[0]);
        expect(event).toMatchObject({ type: 'detection', offset: 0 });
        if (event.type !== 'detection') throw new Error('expected detection');
        expect(event.detection.key).toBe('N20|2026-11-15|243|-2.51230|113.80440');
        expect(event.detection.lat).toBe(-2.5123);
        expect(iso(event.detection.eventTimeMs)).toBe('2026-11-15T02:43:00.000Z');
    });

    it('keeps acq_time sent as a string verbatim in the key', () => {
        const event = parseLogRecord(new LogBuilder().detection({ time: '0243', lat: '1.0', lon: '2.0' }).records[0]);
        expect(event.type === 'detection' && event.detection.key).toBe('N20|2026-11-15|0243|1.0|2.0');
    });

    it('accepts retract by detection_key or by detection object (DUGAAN)', () => {
        const d = { lat: '-1.00000', lon: '110.00000' };
        const log = new LogBuilder().retract(d).retractByDetection(d);
        expect(parseLogRecord(log.records[0])).toMatchObject({
            type: 'retract',
            key: 'N20|2026-11-15|300|-1.00000|110.00000',
        });
        expect(parseLogRecord(log.records[1])).toMatchObject({
            type: 'retract',
            key: 'N20|2026-11-15|300|-1.00000|110.00000',
        });
    });

    it('reports unknown shapes as invalid instead of throwing', () => {
        expect(parseLogRecord({ offset: 3, kind: 'update', data_raw: '{"offset":3}' })).toMatchObject({
            type: 'invalid',
            offset: 3,
        });
        expect(parseLogRecord({ offset: 4, kind: 'detection', data_raw: '{"offset":4' })).toMatchObject({
            type: 'invalid',
        });
        expect(parseLogRecord({ offset: 5, kind: 'mystery' })).toMatchObject({ type: 'invalid' });
        expect(parseLogRecord({ offset: -1, kind: 'detection' })).toMatchObject({ type: 'invalid', offset: null });
    });

    it('reads virtual_now from heartbeats', () => {
        const event = parseLogRecord(new LogBuilder().heartbeat('2026-11-15T00:16:00Z').records[0]);
        expect(event).toEqual({ type: 'heartbeat', offset: 0, virtualNowMs: Date.parse('2026-11-15T00:16:00Z') });
    });

    it('maps unprocessed records', () => {
        expect(parseLogRecord(new LogBuilder().unprocessed().records[0])).toEqual({ type: 'unprocessed', offset: 0 });
    });
});

describe('rawObjectMembers', () => {
    it('returns raw tokens, including braces inside strings', () => {
        const members = rawObjectMembers('{ "a" : 367.0 , "b":"x}{\\"", "c":{"d":[1,{"e":2}]}, "f":true }')!;
        expect(members.get('a')).toEqual({ kind: 'number', raw: '367.0' });
        expect(members.get('b')).toMatchObject({ kind: 'string', value: 'x}{"' });
        expect(members.get('c')).toEqual({ kind: 'object', raw: '{"d":[1,{"e":2}]}' });
        expect(members.get('f')).toEqual({ kind: 'literal', raw: 'true' });
    });

    it('rejects invalid JSON and non-objects', () => {
        expect(rawObjectMembers('{"a":1')).toBeNull();
        expect(rawObjectMembers('[1]')).toBeNull();
    });
});

describe('decimal arithmetic', () => {
    it('sums exactly', () => {
        const sum = sumDecimals(['0.1', '0.2', '11.71'].map((t) => parseDecimal(t)!));
        expect(formatDecimal(sum)).toBe('12.01');
    });

    it('divides with half-even rounding', () => {
        expect(formatDecimal(divideHalfEven(parseDecimal('0.0000005')!, 1n, 6))).toBe('0.000000');
        expect(formatDecimal(divideHalfEven(parseDecimal('0.0000015')!, 1n, 6))).toBe('0.000002');
        expect(formatDecimal(divideHalfEven(parseDecimal('-5.1')!, 2n, 6))).toBe('-2.550000');
        expect(formatDecimal(divideHalfEven(parseDecimal('1')!, 3n, 6))).toBe('0.333333');
    });

    it('parses exponents and compares across scales', () => {
        expect(formatDecimal(parseDecimal('1.5e2')!)).toBe('150');
        expect(compareDecimal(parseDecimal('30')!, parseDecimal('30.00')!)).toBe(0);
        expect(compareDecimal(parseDecimal('29.99')!, parseDecimal('30')!)).toBe(-1);
    });
});
