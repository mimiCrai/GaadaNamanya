import { Response } from 'express';

export const DEEP_NESTING_DEPTH = 10_000;
export const OVERSIZED_CHUNK_BYTES = 64 * 1024;

const JSON_TYPE = 'application/json; charset=utf-8';

// complete HTTP body whose JSON stops at ~60% (no closing brackets)
export function truncatedBody(envelope: unknown): Buffer {
    const full = Buffer.from(JSON.stringify(envelope));
    return full.subarray(0, Math.max(1, Math.floor(full.length * 0.6)));
}

// well-formed JSON nested far deeper than any sane parser limit
export function deepNestingBody(depth = DEEP_NESTING_DEPTH): Buffer {
    return Buffer.from(`{"data":${'['.repeat(depth)}${']'.repeat(depth)}}`);
}

// the real envelope with the bytes C3 28 (invalid UTF-8) inside a string value
export function invalidUtf8Body(envelope: { data: unknown[]; meta: Record<string, unknown> }): Buffer {
    const marker = '__PVMBG_INVALID_UTF8__';
    const text = JSON.stringify({ ...envelope, meta: { ...envelope.meta, note: marker } });
    const [head, tail] = text.split(marker);
    return Buffer.concat([Buffer.from(head), Buffer.from([0xc3, 0x28]), Buffer.from(tail)]);
}

export function sendBytes(res: Response, body: Buffer): void {
    res.status(200).type(JSON_TYPE).send(body);
}

// streams a valid but oversized envelope chunk by chunk; memory stays at one chunk
export async function streamOversized(
    res: Response,
    envelope: { data: unknown[]; meta: Record<string, unknown> },
    totalBytes: number
): Promise<void> {
    const records = envelope.data.map((record) => JSON.stringify(record)).join(',');
    const head = `{"data":[${records}${records ? ',' : ''}{"padding":"`;
    const tail = `"}],"meta":${JSON.stringify(envelope.meta)}}`;
    let padding = Math.max(0, totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail));
    const chunk = Buffer.alloc(OVERSIZED_CHUNK_BYTES, 'x');

    // no-transform: compression would hide backpressure (it does not proxy removeListener)
    res.status(200).type(JSON_TYPE).setHeader('Cache-Control', 'no-transform');
    let closed = false;
    res.once('close', () => (closed = true));
    if (!res.write(head)) await drainOrClose(res);
    while (padding > 0 && !closed) {
        const size = Math.min(padding, chunk.length);
        padding -= size;
        if (!res.write(size === chunk.length ? chunk : chunk.subarray(0, size))) await drainOrClose(res);
    }
    if (!closed) res.end(tail);
}

function drainOrClose(res: Response): Promise<void> {
    return new Promise((resolve) => {
        const done = () => {
            res.removeListener('drain', done);
            res.removeListener('close', done);
            resolve();
        };
        res.on('drain', done);
        res.on('close', done);
    });
}
