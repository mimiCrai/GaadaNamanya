import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { ProcessingError } from './processing-error';

export interface PayloadRef {
    id: string;
}

export interface OverflowSink {
    write(chunk: Buffer): Promise<void>;
    finish(): Promise<PayloadRef>;
    abort(): Promise<void>;
}

export type LimitedRead =
    | { kind: 'complete'; bytes: Buffer; size: number; sha256: string }
    | { kind: 'overflow'; size: number; sha256: string; ref: PayloadRef | null; head: Buffer };

const HEAD_BYTES = 1024;

export async function readLimited(
    source: AsyncIterable<Uint8Array>,
    maxBytes: number,
    openOverflow?: () => OverflowSink | Promise<OverflowSink>
): Promise<LimitedRead> {
    const hash = createHash('sha256');
    let chunks: Buffer[] = [];
    let size = 0;
    let overflowing = false;
    let sink: OverflowSink | undefined;
    let head: Buffer = Buffer.alloc(0);

    try {
        for await (const chunk of source) {
            const buffer = Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            hash.update(buffer);
            size += buffer.length;
            if (!overflowing && size <= maxBytes) {
                chunks.push(buffer);
                continue;
            }
            if (!overflowing) {
                overflowing = true;
                head = Buffer.from(Buffer.concat([...chunks, buffer]).subarray(0, HEAD_BYTES));
                sink = openOverflow ? await openOverflow() : undefined;
                for (const buffered of chunks) await sink?.write(buffered);
                chunks = [];
            }
            await sink?.write(buffer);
        }
    } catch (error) {
        await sink?.abort().catch(() => undefined);
        throw error;
    }

    const sha256 = hash.digest('hex');
    if (!overflowing) return { kind: 'complete', bytes: Buffer.concat(chunks, size), size, sha256 };
    const ref = sink ? await sink.finish() : null;
    return { kind: 'overflow', size, sha256, ref, head };
}

export function payloadTooLarge(size: number, maxBytes: number): ProcessingError {
    return new ProcessingError('payload_too_large', `ukuran ${size} byte melebihi batas ${maxBytes} byte`);
}

export function checkUtf8(bytes: Buffer): string {
    if (!isUtf8(bytes)) {
        throw new ProcessingError(
            'invalid_utf8',
            `byte UTF-8 tidak valid pada offset ${firstInvalidUtf8Offset(bytes)}`
        );
    }
    return bytes.toString('utf8');
}

export function firstInvalidUtf8Offset(bytes: Buffer): number {
    let i = 0;
    while (i < bytes.length) {
        const b = bytes[i];
        let need: number;
        let min: number;
        if (b < 0x80) {
            i++;
            continue;
        } else if (b >= 0xc2 && b <= 0xdf) {
            need = 1;
            min = 0x80;
        } else if (b >= 0xe0 && b <= 0xef) {
            need = 2;
            min = 0x800;
        } else if (b >= 0xf0 && b <= 0xf4) {
            need = 3;
            min = 0x10000;
        } else {
            return i;
        }
        let codePoint = b & (0xff >> (need + 2));
        for (let k = 1; k <= need; k++) {
            const next = bytes[i + k];
            if (next === undefined || (next & 0xc0) !== 0x80) return i;
            codePoint = (codePoint << 6) | (next & 0x3f);
        }
        if (codePoint < min || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return i;
        i += need + 1;
    }
    return -1;
}

export function checkDepth(bytes: Buffer, maxDepth: number): number {
    let depth = 0;
    let deepest = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (b === 0x5c) escaped = true;
            else if (b === 0x22) inString = false;
            continue;
        }
        if (b === 0x22) inString = true;
        else if (b === 0x7b || b === 0x5b) {
            depth++;
            if (depth > maxDepth) {
                throw new ProcessingError(
                    'nesting_too_deep',
                    `kedalaman nesting melebihi ${maxDepth} pada offset ${i}`
                );
            }
            if (depth > deepest) deepest = depth;
        } else if (b === 0x7d || b === 0x5d) depth--;
    }
    return deepest;
}

export function parseJson(text: string): unknown {
    if (text.trim() === '') throw new ProcessingError('malformed_json', 'payload kosong');
    try {
        return JSON.parse(text);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const truncated = isTruncated(text) || /unexpected end|unterminated/i.test(message);
        throw new ProcessingError(
            'malformed_json',
            `${truncated ? 'JSON terpotong' : 'JSON tidak valid'} (${message})`
        );
    }
}

function isTruncated(text: string): boolean {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (inString) {
            if (escaped) escaped = false;
            else if (c === 0x5c) escaped = true;
            else if (c === 0x22) inString = false;
        } else if (c === 0x22) inString = true;
        else if (c === 0x7b || c === 0x5b) depth++;
        else if (c === 0x7d || c === 0x5d) depth--;
    }
    return inString || depth > 0;
}

export interface DecodeOptions {
    maxDepth: number;
}

export function decodeJson(bytes: Buffer, options: DecodeOptions): unknown {
    const text = checkUtf8(bytes);
    checkDepth(bytes, options.maxDepth);
    return parseJson(text);
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

function skipWs(bytes: Buffer, i: number): number {
    while (i < bytes.length && WS.has(bytes[i])) i++;
    return i;
}

function skipString(bytes: Buffer, i: number): number {
    // bytes[i] is the opening quote
    for (let j = i + 1; j < bytes.length; j++) {
        if (bytes[j] === 0x5c) j++;
        else if (bytes[j] === 0x22) return j + 1;
    }
    return bytes.length;
}

function skipValue(bytes: Buffer, i: number): number {
    const b = bytes[i];
    if (b === 0x22) return skipString(bytes, i);
    if (b === 0x7b || b === 0x5b) {
        let depth = 0;
        for (let j = i; j < bytes.length; j++) {
            const c = bytes[j];
            if (c === 0x22) {
                j = skipString(bytes, j) - 1;
            } else if (c === 0x7b || c === 0x5b) depth++;
            else if (c === 0x7d || c === 0x5d) {
                depth--;
                if (depth === 0) return j + 1;
            }
        }
        return bytes.length;
    }
    let j = i;
    while (j < bytes.length && !WS.has(bytes[j]) && bytes[j] !== 0x2c && bytes[j] !== 0x7d && bytes[j] !== 0x5d) j++;
    return j;
}

function arrayElements(bytes: Buffer, arrayStart: number): Buffer[] {
    const elements: Buffer[] = [];
    let i = skipWs(bytes, arrayStart + 1);
    while (i < bytes.length && bytes[i] !== 0x5d) {
        const end = skipValue(bytes, i);
        elements.push(bytes.subarray(i, end));
        i = skipWs(bytes, end);
        if (bytes[i] === 0x2c) i = skipWs(bytes, i + 1);
    }
    return elements;
}

function objectValueStart(bytes: Buffer, objectStart: number, key: string): number | undefined {
    let i = skipWs(bytes, objectStart + 1);
    while (i < bytes.length && bytes[i] === 0x22) {
        const keyEnd = skipString(bytes, i);
        const name = JSON.parse(bytes.subarray(i, keyEnd).toString('utf8')) as string;
        i = skipWs(bytes, keyEnd);
        i = skipWs(bytes, i + 1); // ':'
        if (name === key) return i;
        i = skipWs(bytes, skipValue(bytes, i));
        if (bytes[i] === 0x2c) i = skipWs(bytes, i + 1);
    }
    return undefined;
}

export function splitRecords(bytes: Buffer, parsed: unknown, envelopeKey = 'data'): Buffer[] {
    const start = skipWs(bytes, 0);
    if (Array.isArray(parsed) && bytes[start] === 0x5b) return arrayElements(bytes, start);
    if (
        parsed !== null &&
        typeof parsed === 'object' &&
        Array.isArray((parsed as Record<string, unknown>)[envelopeKey]) &&
        bytes[start] === 0x7b
    ) {
        const valueStart = objectValueStart(bytes, start, envelopeKey);
        if (valueStart !== undefined && bytes[valueStart] === 0x5b) return arrayElements(bytes, valueStart);
    }
    throw new ProcessingError(
        'schema_incompatible',
        `respons harus berupa array atau objek dengan array '${envelopeKey}'`
    );
}

export interface RawRecord {
    raw: Buffer;
    value: unknown;
}

export function toRawRecords(bytes: Buffer, parsed: unknown, envelopeKey = 'data'): RawRecord[] {
    const slices = splitRecords(bytes, parsed, envelopeKey);
    const values = Array.isArray(parsed) ? parsed : ((parsed as Record<string, unknown>)[envelopeKey] as unknown[]);
    if (slices.length !== values.length) {
        throw new ProcessingError(
            'malformed_json',
            `jumlah record tidak konsisten (${slices.length} vs ${values.length})`
        );
    }
    return slices.map((raw, index) => ({ raw, value: values[index] }));
}
