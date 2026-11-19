import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SseItem, SseParser } from '../../src/libs/sse-parser';
import { checkUtf8 } from '../../src/libs/safe-decode';
import { ProcessingError } from '../../src/libs/processing-error';

const FIXTURES = path.resolve(__dirname, '../../../../tests/fixtures/satellite');
const detectionSse = readFileSync(path.join(FIXTURES, 'detection.sse'));
const heartbeatSse = readFileSync(path.join(FIXTURES, 'heartbeat.sse'));

interface RawLine {
    id: string;
    event: string;
    data: unknown;
}
const rawLines: RawLine[] = readFileSync(path.join(FIXTURES, 'stream-raw.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/** The full 60 s observation (25 events) rebuilt as an SSE byte stream. */
function fullStream(eol = '\n'): Buffer {
    return Buffer.from(
        rawLines
            .map((e) => `id: ${e.id}${eol}event: ${e.event}${eol}data: ${JSON.stringify(e.data)}${eol}${eol}`)
            .join('')
    );
}

const MAX = 1024 * 1024;

function parseAll(chunks: Uint8Array[], maxEventBytes = MAX): SseItem[] {
    const parser = new SseParser({ maxEventBytes });
    const items = chunks.flatMap((chunk) => parser.push(chunk));
    return [...items, ...parser.end()];
}

/** Comparable view of items (Buffer → string). */
function view(items: SseItem[]) {
    return items.map((item) => (item.type === 'event' ? { ...item, data: item.data.toString('utf8') } : item));
}

function events(items: SseItem[]) {
    return items.filter((item): item is Extract<SseItem, { type: 'event' }> => item.type === 'event');
}

/** Deterministic PRNG (mulberry32) so random chunking is reproducible. */
function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomChunks(bytes: Buffer, random: () => number, maxSize: number): Buffer[] {
    const chunks: Buffer[] = [];
    for (let position = 0; position < bytes.length;) {
        const size = 1 + Math.floor(random() * maxSize);
        chunks.push(bytes.subarray(position, position + size));
        position += size;
    }
    return chunks;
}

describe('SseParser — Tahap 0 fixtures', () => {
    it('parses detection.sse with exact raw data bytes', () => {
        const parsed = events(parseAll([detectionSse]));
        expect(parsed.map((e) => e.id)).toEqual(['0', '1', '2', '3', '4']);
        expect(parsed.every((e) => e.event === 'detection')).toBe(true);
        for (const event of parsed) {
            expect(JSON.parse(event.data.toString('utf8')).offset).toBe(Number(event.id));
        }
        // Raw token is kept: JSON.parse would turn 367.0 into 367 (D-10).
        expect(parsed[4].data.toString('utf8')).toContain('"bright_ti4":367.0');
    });

    it('parses heartbeat.sse including virtual_now', () => {
        const parsed = events(parseAll([heartbeatSse]));
        expect(parsed.map((e) => [e.id, e.event])).toEqual([
            ['5', 'heartbeat'],
            ['22', 'heartbeat'],
        ]);
        expect(JSON.parse(parsed[1].data.toString('utf8'))).toEqual({
            offset: 22,
            virtual_now: '2026-11-15T00:34:12Z',
        });
    });

    it('parses the whole observed stream in order (ids 0..24)', () => {
        const parsed = events(parseAll([fullStream()]));
        expect(parsed.map((e) => e.id)).toEqual(rawLines.map((e) => e.id));
        expect(parsed.map((e) => e.event)).toEqual(rawLines.map((e) => e.event));
        expect(parsed.map((e) => JSON.parse(e.data.toString('utf8')))).toEqual(rawLines.map((e) => e.data));
    });
});

describe('SseParser — events cut at arbitrary points', () => {
    const sample = Buffer.concat([detectionSse, heartbeatSse]);
    const expected = view(parseAll([sample]));

    it('gives identical output for a two-part split at every byte position', () => {
        for (let cut = 0; cut <= sample.length; cut++) {
            expect(view(parseAll([sample.subarray(0, cut), sample.subarray(cut)]))).toEqual(expected);
        }
    });

    it('gives identical output for one byte per chunk', () => {
        const chunks = [...sample].map((byte) => Buffer.from([byte]));
        expect(view(parseAll(chunks))).toEqual(expected);
    });

    it.each(['\n', '\r\n', '\r'])('gives identical output for random chunking with EOL %j', (eol) => {
        const stream = fullStream(eol);
        const reference = view(parseAll([stream]));
        expect(events(parseAll([stream]))).toHaveLength(25);
        const random = prng(eol.length * 7919 + eol.charCodeAt(0));
        for (let round = 0; round < 200; round++) {
            expect(view(parseAll(randomChunks(stream, random, 1 + (round % 40))))).toEqual(reference);
        }
    });

    it('accepts empty chunks anywhere', () => {
        const parser = new SseParser({ maxEventBytes: MAX });
        const items = [
            ...parser.push(Buffer.alloc(0)),
            ...parser.push(Buffer.from('data: a\r')),
            ...parser.push(Buffer.alloc(0)),
            ...parser.push(Buffer.from('\n')),
            ...parser.push(Buffer.alloc(0)),
            ...parser.push(Buffer.from('\n')),
        ];
        expect(view(items)).toEqual([
            { type: 'event', id: null, lastEventId: '', event: 'message', data: 'a', bytes: 9 },
        ]);
    });

    it('accepts Uint8Array chunks that are views into a larger buffer', () => {
        const backing = new Uint8Array(Buffer.from('xxdata: a\n\nyy'));
        expect(events(parseAll([backing.subarray(2, 11)])).map((e) => e.data.toString())).toEqual(['a']);
    });
});

describe('SseParser — line endings', () => {
    const canonical = view(parseAll([Buffer.from('id: 1\nevent: detection\ndata: {"a":1}\n\n')]));

    it.each([
        ['CRLF', 'id: 1\r\nevent: detection\r\ndata: {"a":1}\r\n\r\n'],
        ['CR only', 'id: 1\revent: detection\rdata: {"a":1}\r\r'],
        ['mixed', 'id: 1\r\nevent: detection\rdata: {"a":1}\n\r\n'],
    ])('treats %s like LF', (_label, text) => {
        const items = view(parseAll([Buffer.from(text)]));
        expect(items.map((i) => ({ ...i, bytes: 0 }))).toEqual(canonical.map((i) => ({ ...i, bytes: 0 })));
    });

    it('does not count a CRLF split across chunks as two line endings', () => {
        // "data: a\r" | "\ndata: b\r" | "\n\r\n" → one event "a\nb"; a stray blank line would split it in two.
        const items = events(parseAll([Buffer.from('data: a\r'), Buffer.from('\ndata: b\r'), Buffer.from('\n\r\n')]));
        expect(items.map((e) => e.data.toString())).toEqual(['a\nb']);
    });

    it('treats CR followed by CR in the next chunk as a line end plus a blank line', () => {
        const items = events(parseAll([Buffer.from('data: a\r'), Buffer.from('\r')]));
        expect(items.map((e) => e.data.toString())).toEqual(['a']);
    });
});

describe('SseParser — fields', () => {
    it('joins multi-line data with LF, including empty data lines', () => {
        const items = events(parseAll([Buffer.from('data: line1\ndata: line2\ndata\ndata:\n\n')]));
        expect(items.map((e) => e.data.toString())).toEqual(['line1\nline2\n\n']);
    });

    it('dispatches an event whose only data line is empty', () => {
        expect(events(parseAll([Buffer.from('data\n\n')])).map((e) => e.data.toString())).toEqual(['']);
    });

    it('strips exactly one leading space from values', () => {
        const items = events(parseAll([Buffer.from('data:x\n\ndata:  x\n\ndata: \n\n')]));
        expect(items.map((e) => e.data.toString())).toEqual(['x', ' x', '']);
    });

    it('splits on the first colon only', () => {
        const items = events(parseAll([Buffer.from('data: {"t":"02:43"}\n\n')]));
        expect(items[0].data.toString()).toBe('{"t":"02:43"}');
    });

    it('reports comments and does not let them break an event', () => {
        const items = view(parseAll([Buffer.from(': keepalive\nid: 7\n:mid-event comment\ndata: x\n\n')]));
        expect(items).toEqual([
            { type: 'comment', text: 'keepalive' },
            { type: 'comment', text: 'mid-event comment' },
            { type: 'event', id: '7', lastEventId: '7', event: 'message', data: 'x', bytes: expect.any(Number) },
        ]);
    });

    it('a comment-only block dispatches nothing', () => {
        expect(events(parseAll([Buffer.from(':ping\n\n:ping\n\n')]))).toEqual([]);
    });

    it('uses `message` as the default and for an empty event type', () => {
        const items = events(parseAll([Buffer.from('data: a\n\nevent\ndata: b\n\nevent: update\ndata: c\n\n')]));
        expect(items.map((e) => e.event)).toEqual(['message', 'message', 'update']);
    });

    it('event type does not leak into the next event', () => {
        const items = events(parseAll([Buffer.from('event: retract\ndata: a\n\ndata: b\n\n')]));
        expect(items.map((e) => e.event)).toEqual(['retract', 'message']);
    });

    it('keeps lastEventId sticky while `id` is per block', () => {
        const items = events(parseAll([Buffer.from('id: 5\ndata: a\n\ndata: b\n\nid\ndata: c\n\n')]));
        expect(items.map((e) => [e.id, e.lastEventId])).toEqual([
            ['5', '5'],
            [null, '5'],
            ['', ''],
        ]);
    });

    it('ignores an id that contains NUL', () => {
        const items = events(parseAll([Buffer.from('id: 3\ndata: a\n\nid: 4\u00005\ndata: b\n\n')]));
        expect(items.map((e) => [e.id, e.lastEventId])).toEqual([
            ['3', '3'],
            [null, '3'],
        ]);
    });

    it('updates lastEventId from a block without data, without dispatching it', () => {
        const items = events(parseAll([Buffer.from('id: 9\nevent: detection\n\ndata: a\n\n')]));
        expect(items.map((e) => [e.id, e.lastEventId, e.event])).toEqual([[null, '9', 'message']]);
    });

    it('accepts only all-digit retry values', () => {
        const items = parseAll([Buffer.from('retry: 3000\nretry: 3s\nretry:  10\nretry: -1\nretry:\nretry: 0\n\n')]);
        expect(items).toEqual([
            { type: 'retry', ms: 3000 },
            { type: 'retry', ms: 0 },
        ]);
    });

    it('ignores unknown fields and fields without a colon', () => {
        const items = events(parseAll([Buffer.from('foo: bar\nidx: 1\nDATA: no\nid: 2\ndata: yes\n\n')]));
        expect(items.map((e) => [e.id, e.data.toString()])).toEqual([['2', 'yes']]);
    });
});

describe('SseParser — robustness', () => {
    it('strips a UTF-8 BOM at the start of the stream, also when split', () => {
        const stream = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('data: a\n\n')]);
        expect(events(parseAll([stream])).map((e) => e.data.toString())).toEqual(['a']);
        expect(events(parseAll([stream.subarray(0, 1), stream.subarray(1, 2), stream.subarray(2)]))).toHaveLength(1);
    });

    it('does not strip a BOM after the first line', () => {
        const stream = Buffer.concat([
            Buffer.from('data: a\n\n'),
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from('data: b\n\n'),
        ]);
        // The second block's first line starts with the BOM, so its field name is not `data` and it is ignored.
        expect(events(parseAll([stream])).map((e) => e.data.toString())).toEqual(['a']);
    });

    it('keeps invalid UTF-8 confined to one event', () => {
        const bad = Buffer.concat([
            Buffer.from('id: 1\ndata: {"x":"'),
            Buffer.from([0xc3, 0x28]),
            Buffer.from('"}\n\n'),
        ]);
        const stream = Buffer.concat([
            Buffer.from('id: 0\ndata: {"ok":true}\n\n'),
            bad,
            Buffer.from('id: 2\ndata: {"ok":2}\n\n'),
        ]);
        const parsed = events(parseAll([stream]));
        expect(parsed.map((e) => e.id)).toEqual(['0', '1', '2']);
        expect(checkUtf8(parsed[0].data)).toBe('{"ok":true}');
        expect(() => checkUtf8(parsed[1].data)).toThrow(ProcessingError);
        expect(checkUtf8(parsed[2].data)).toBe('{"ok":2}');
    });

    it('reports an oversized event once, skips it without buffering, then resumes', () => {
        const parser = new SseParser({ maxEventBytes: 64 });
        const items: SseItem[] = [];
        items.push(...parser.push(Buffer.from('id: 10\nevent: detection\ndata: ')));
        let maxBuffered = parser.bufferedBytes;
        for (let i = 0; i < 1000; i++) {
            items.push(...parser.push(Buffer.alloc(97, 0x61)));
            maxBuffered = Math.max(maxBuffered, parser.bufferedBytes);
        }
        items.push(...parser.push(Buffer.from('\ndata: more\n\nid: 11\ndata: ok\n\n')));
        expect(maxBuffered).toBeLessThanOrEqual(64);
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ type: 'oversized', id: '10' });
        expect(items[0].type === 'oversized' && items[0].bytes).toBeGreaterThan(64);
        expect(view([items[1]])).toEqual([
            { type: 'event', id: '11', lastEventId: '11', event: 'message', data: 'ok', bytes: 17 },
        ]);
    });

    it('counts all lines of a block towards the limit', () => {
        const lines = Array.from({ length: 10 }, (_, i) => `data: ${'x'.repeat(10)}${i}`).join('\n');
        const items = parseAll([Buffer.from(`${lines}\n\ndata: next\n\n`)], 64);
        expect(items.map((i) => i.type)).toEqual(['oversized', 'event']);
    });

    it('does not dispatch an event left unterminated at end of stream', () => {
        expect(parseAll([Buffer.from('id: 1\ndata: complete\n\nid: 2\ndata: cut')])).toEqual([
            expect.objectContaining({ type: 'event', id: '1' }),
            { type: 'incomplete', bytes: 15 },
        ]);
        expect(parseAll([Buffer.from('data: x\n')]).map((i) => i.type)).toEqual(['incomplete']);
        expect(parseAll([Buffer.from('data: x\n\n')]).map((i) => i.type)).toEqual(['event']);
    });

    it('resets on end() so the instance can serve a new connection', () => {
        const parser = new SseParser({ maxEventBytes: MAX });
        parser.push(Buffer.from('id: 4\ndata: a\n\ndata: half'));
        parser.end();
        const items = events(parser.push(Buffer.from('data: b\n\n')));
        expect(items.map((e) => [e.data.toString(), e.lastEventId])).toEqual([['b', '']]);
    });

    it('rejects an invalid limit', () => {
        expect(() => new SseParser({ maxEventBytes: 0 })).toThrow(RangeError);
    });
});
