import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeSatelliteEvent, parseOffsetId, SseEventItem } from '../../src/libs/satellite-envelope';
import { SseParser } from '../../src/libs/sse-parser';

const FIXTURES = path.resolve(__dirname, '../../../../tests/fixtures/satellite');

function item(id: string | null, event: string, data: string | Buffer): SseEventItem {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return { type: 'event', id, lastEventId: id ?? '', event, data: bytes, bytes: bytes.length };
}

function fixtureEvents(file: string): SseEventItem[] {
    const parser = new SseParser({ maxEventBytes: 1 << 20 });
    return parser.push(readFileSync(path.join(FIXTURES, file))).filter((i): i is SseEventItem => i.type === 'event');
}

const decode = (event: SseEventItem) => decodeSatelliteEvent(event, { maxDepth: 64 });

const DETECTION = {
    satellite: 'N20',
    acq_date: '2026-11-14',
    acq_time: 243,
    latitude: -2.5123,
    longitude: 113.8044,
    confidence: 'h',
    frp: 4.5,
};

describe('decodeSatelliteEvent', () => {
    it('accepts every Tahap 0 fixture event and keeps the raw text', () => {
        const decoded = [...fixtureEvents('detection.sse'), ...fixtureEvents('heartbeat.sse')].map(decode);
        expect(decoded.every((d) => d.ok)).toBe(true);
        expect(decoded.map((d) => d.offset)).toEqual([0, 1, 2, 3, 4, 5, 22]);
        const fourth = decoded[4];
        expect(fourth.ok && fourth.dataText).toContain('"bright_ti4":367.0');
        const heartbeat = decoded[6];
        expect(heartbeat.ok && heartbeat.kind).toBe('heartbeat');
        expect(heartbeat.ok && heartbeat.virtualNow).toBe('2026-11-15T00:34:12Z');
    });

    it('accepts acq_time as a string without leading zeros and update/retract envelopes', () => {
        const string = decode(
            item('7', 'detection', JSON.stringify({ offset: 7, detection: { ...DETECTION, acq_time: '243' } }))
        );
        expect(string.ok).toBe(true);
        expect(decode(item('8', 'update', '{"offset":8,"anything":{"x":1}}')).ok).toBe(true);
        expect(decode(item('9', 'retract', '{"offset":9}')).ok).toBe(true);
    });

    it.each([
        ['truncated JSON', item('3', 'detection', '{"offset":3,"detection":{"satellite":"N2'), 'malformed_json', 3],
        [
            'invalid UTF-8',
            item(
                '4',
                'detection',
                Buffer.concat([Buffer.from('{"offset":4,"x":"'), Buffer.from([0xff]), Buffer.from('"}')])
            ),
            'invalid_utf8',
            4,
        ],
        [
            'deep nesting',
            item('5', 'detection', `{"offset":5,"d":${'['.repeat(100)}${']'.repeat(100)}}`),
            'nesting_too_deep',
            5,
        ],
        ['missing offset', item('6', 'detection', '{"detection":{}}'), 'schema_incompatible', 6],
        [
            'offset mismatch',
            item('7', 'heartbeat', '{"offset":8,"virtual_now":"2026-11-15T00:16:00Z"}'),
            'validation_failed',
            7,
        ],
        ['unknown event type', item('8', 'surprise', '{"offset":8}'), 'validation_failed', 8],
        [
            'detection field missing',
            item('9', 'detection', JSON.stringify({ offset: 9, detection: { ...DETECTION, latitude: undefined } })),
            'schema_incompatible',
            9,
        ],
        [
            'confidence out of contract',
            item('10', 'detection', JSON.stringify({ offset: 10, detection: { ...DETECTION, confidence: 'x' } })),
            'validation_failed',
            10,
        ],
        [
            'acq_time minutes >= 60',
            item('11', 'detection', JSON.stringify({ offset: 11, detection: { ...DETECTION, acq_time: 275 } })),
            'validation_failed',
            11,
        ],
        ['heartbeat without virtual_now', item('12', 'heartbeat', '{"offset":12}'), 'schema_incompatible', 12],
    ])('rejects %s with the Tahap 1 category and keeps the offset', (_label, event, category, offset) => {
        const decoded = decode(event);
        expect(decoded.ok).toBe(false);
        if (decoded.ok) return;
        expect(decoded.error.category).toBe(category);
        expect(decoded.error.retryable).toBe(false);
        expect(decoded.offset).toBe(offset);
    });

    it('prefixes detection field errors', () => {
        const decoded = decode(
            item('9', 'detection', JSON.stringify({ offset: 9, detection: { ...DETECTION, frp: 'big' } }))
        );
        expect(!decoded.ok && decoded.error.reason).toBe(
            "schema_incompatible: detection: field 'frp' berubah dari number menjadi string"
        );
    });

    it('falls back to data.offset when the SSE id is missing, and to null when nothing is readable', () => {
        const fromData = decode(item(null, 'detection', '{"offset":5,"detection":{}}'));
        expect(fromData.ok).toBe(false);
        expect(fromData.offset).toBe(5);
        expect(decode(item(null, 'detection', 'not json')).offset).toBeNull();
        expect(decode(item('abc', 'detection', 'not json')).offset).toBeNull();
    });
});

describe('parseOffsetId', () => {
    it.each([
        ['0', 0],
        ['42', 42],
        ['007', null],
        ['-1', null],
        ['1.5', null],
        ['', null],
        [null, null],
        ['99999999999999999', null],
    ])('%j → %j', (input, expected) => {
        expect(parseOffsetId(input)).toBe(expected);
    });
});
