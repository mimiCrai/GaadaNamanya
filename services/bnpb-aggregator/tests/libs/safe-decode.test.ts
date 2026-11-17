import { createHash } from 'node:crypto';
import {
    checkDepth,
    checkUtf8,
    decodeJson,
    firstInvalidUtf8Offset,
    OverflowSink,
    parseJson,
    readLimited,
    splitRecords,
    toRawRecords,
} from '../../src/libs/safe-decode';
import { ProcessingError } from '../../src/libs/processing-error';

const MiB = 1024 * 1024;

async function* chunked(buffer: Buffer, size = 64 * 1024): AsyncIterable<Uint8Array> {
    for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size);
}

/** Deterministic generator of `total` bytes in 64 KiB chunks without holding them all in memory. */
async function* generated(total: number, onChunk: (chunk: Buffer) => void): AsyncIterable<Uint8Array> {
    const chunkSize = 64 * 1024;
    let produced = 0;
    let seed = 0;
    while (produced < total) {
        const length = Math.min(chunkSize, total - produced);
        const chunk = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i++) chunk[i] = 0x61 + ((seed++ * 31) % 26);
        onChunk(chunk);
        produced += length;
        yield chunk;
    }
}

function hashingSink(): OverflowSink & { digest(): string; bytes: number; finished: boolean } {
    const hash = createHash('sha256');
    const state = { bytes: 0, finished: false };
    return {
        async write(chunk) {
            hash.update(chunk);
            state.bytes += chunk.length;
        },
        async finish() {
            state.finished = true;
            return { id: 'fake-gridfs-id' };
        },
        async abort() {},
        digest: () => hash.digest('hex'),
        get bytes() {
            return state.bytes;
        },
        get finished() {
            return state.finished;
        },
    };
}

function expectCategory(fn: () => unknown, category: string) {
    try {
        fn();
    } catch (error) {
        expect(error).toBeInstanceOf(ProcessingError);
        expect((error as ProcessingError).category).toBe(category);
        expect((error as ProcessingError).reason.startsWith(`${category}: `)).toBe(true);
        return error as ProcessingError;
    }
    throw new Error(`expected ${category}`);
}

describe('readLimited', () => {
    it('returns the exact bytes and hash when within the limit', async () => {
        const body = Buffer.from('{"data":[1,2,3]}');
        const result = await readLimited(chunked(body, 3), 1024);
        expect(result.kind).toBe('complete');
        if (result.kind !== 'complete') return;
        expect(result.bytes.equals(body)).toBe(true);
        expect(result.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    });

    it('streams a 50 MB payload into the overflow sink intact with bounded memory', async () => {
        const total = 50 * MiB;
        const sourceHash = createHash('sha256');
        const sink = hashingSink();
        global.gc?.();
        const baseline = process.memoryUsage();
        let peakHeap = baseline.heapUsed;
        let peakRss = baseline.rss;
        let peakBuffers = baseline.arrayBuffers;
        const sample = () => {
            const usage = process.memoryUsage();
            peakHeap = Math.max(peakHeap, usage.heapUsed);
            peakRss = Math.max(peakRss, usage.rss);
            peakBuffers = Math.max(peakBuffers, usage.arrayBuffers);
        };
        const sampler = setInterval(sample, 10);

        const result = await readLimited(
            generated(total, (chunk) => sourceHash.update(chunk)),
            5 * MiB,
            () => sink
        );
        clearInterval(sampler);
        sample();

        expect(result.kind).toBe('overflow');
        if (result.kind !== 'overflow') return;
        const expected = sourceHash.digest('hex');
        expect(result.size).toBe(total);
        expect(result.sha256).toBe(expected);
        expect(sink.finished).toBe(true);
        expect(sink.bytes).toBe(total);
        expect(sink.digest()).toBe(expected);
        expect(result.ref).toEqual({ id: 'fake-gridfs-id' });
        expect(result.head.length).toBe(1024);

        const growth = (peak: number, base: number) => ((peak - base) / MiB).toFixed(1);
        console.log(
            `[safe-decode 50MB] growth heapUsed=${growth(peakHeap, baseline.heapUsed)}MiB ` +
                `arrayBuffers=${growth(peakBuffers, baseline.arrayBuffers)}MiB rss=${growth(peakRss, baseline.rss)}MiB`
        );
        // In-memory buffering is capped at 5 MiB; allow GC slack but nowhere near the 50 MiB payload.
        expect((peakBuffers - baseline.arrayBuffers) / MiB).toBeLessThan(40);
        expect((peakHeap - baseline.heapUsed) / MiB).toBeLessThan(40);
    }, 60_000);

    it('aborts the sink when the source fails mid-stream', async () => {
        const abort = jest.fn().mockResolvedValue(undefined);
        async function* failing(): AsyncIterable<Uint8Array> {
            yield Buffer.alloc(2048);
            throw new Error('socket closed');
        }
        await expect(
            readLimited(failing(), 1024, () => ({ write: jest.fn(), finish: jest.fn(), abort }))
        ).rejects.toThrow('socket closed');
        expect(abort).toHaveBeenCalled();
    });
});

describe('checkUtf8', () => {
    it('rejects invalid UTF-8 and reports the offset', () => {
        const bytes = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]); // {"a":"\xC3("}
        const error = expectCategory(() => checkUtf8(bytes), 'invalid_utf8');
        expect(error.detail).toContain('offset 6');
    });

    it.each([
        [[0xed, 0xa0, 0x80], 0], // UTF-16 surrogate
        [[0xc0, 0xaf], 0], // overlong
        [[0x61, 0xf4, 0x90, 0x80, 0x80], 1], // > U+10FFFF
        [[0x61, 0xe2, 0x82], 1], // truncated sequence
    ])('finds the first invalid byte in %j', (bytes, offset) => {
        expect(firstInvalidUtf8Offset(Buffer.from(bytes))).toBe(offset);
    });

    it('accepts multi-byte text', () => {
        expect(checkUtf8(Buffer.from('{"nama":"Gunung Anak Krakatau 🌋"}'))).toContain('🌋');
    });
});

describe('checkDepth', () => {
    it('rejects 10,000 levels of nesting without recursion', () => {
        const deep = Buffer.from('['.repeat(10_000) + ']'.repeat(10_000));
        const error = expectCategory(() => checkDepth(deep, 64), 'nesting_too_deep');
        expect(error.detail).toContain('64');
    });

    it('ignores brackets inside strings', () => {
        expect(checkDepth(Buffer.from('{"a":"[[[[[[[[[[","b":"\\"]]"}'), 2)).toBe(1);
    });
});

describe('parseJson', () => {
    it('labels truncated JSON', () => {
        const error = expectCategory(() => parseJson('{"data":[{"report_id":"r-1",'), 'malformed_json');
        expect(error.detail).toMatch(/terpotong/);
    });

    it('labels other syntax errors and empty payloads', () => {
        expectCategory(() => parseJson('{"a":01}'), 'malformed_json');
        expect(expectCategory(() => parseJson('  '), 'malformed_json').detail).toContain('kosong');
    });
});

describe('decodeJson pipeline', () => {
    it('runs utf8 → depth → parse in order', () => {
        expect(decodeJson(Buffer.from('{"data":[]}'), { maxDepth: 4 })).toEqual({ data: [] });
        expectCategory(() => decodeJson(Buffer.from([0xff]), { maxDepth: 4 }), 'invalid_utf8');
        expectCategory(() => decodeJson(Buffer.from('[[[[[1]]]]]'), { maxDepth: 4 }), 'nesting_too_deep');
        expectCategory(() => decodeJson(Buffer.from('[1,'), { maxDepth: 4 }), 'malformed_json');
    });
});

describe('record isolation', () => {
    it('returns the exact original bytes of each element of {"data":[...]}', () => {
        const text =
            '{ "meta": {"x":[1,{"data":0}]}, "data" : [ {"a":1.50,"s":"x,]}"} ,\n{"b":[1,[2]]},3 ], "z":true }';
        const bytes = Buffer.from(text);
        const slices = splitRecords(bytes, JSON.parse(text));
        expect(slices.map((slice) => slice.toString())).toEqual(['{"a":1.50,"s":"x,]}"}', '{"b":[1,[2]]}', '3']);
    });

    it('splits a top-level array and pairs slices with parsed values', () => {
        const text = '[{"report_id":"é-1"},{"report_id":"r-2"}]';
        const records = toRawRecords(Buffer.from(text), JSON.parse(text));
        expect(records.map((record) => record.raw.toString())).toEqual(['{"report_id":"é-1"}', '{"report_id":"r-2"}']);
        expect(records[0].value).toEqual({ report_id: 'é-1' });
    });

    it('rejects an envelope without a data array as schema_incompatible', () => {
        const text = '{"reports":[]}';
        expectCategory(() => splitRecords(Buffer.from(text), JSON.parse(text)), 'schema_incompatible');
    });
});
