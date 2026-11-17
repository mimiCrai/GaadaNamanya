import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { PvmbgClient } from '../../src/clients/pvmbg.client';
import { IPayloadStore } from '../../src/repositories/payload-store.repository';
import { OverflowSink } from '../../src/libs/safe-decode';

const options = { correlationId: '00000000-0000-4000-8000-000000000000' };

function streamOf(buffer: Buffer, chunk = 16 * 1024): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream({
        pull(controller) {
            if (offset >= buffer.length) return controller.close();
            controller.enqueue(buffer.subarray(offset, offset + chunk));
            offset += chunk;
        },
    });
}

describe('PvmbgClient safe decoding', () => {
    const written: Buffer[] = [];
    const payloads: jest.Mocked<IPayloadStore> = {
        openSink: jest.fn((_metadata: Record<string, unknown>): OverflowSink => ({
            write: async (chunk: Buffer) => void written.push(Buffer.from(chunk)),
            finish: async () => ({ id: '65f000000000000000000001' }),
            abort: async () => undefined,
        })),
        openDownload: jest.fn(),
        readAll: jest.fn(),
        delete: jest.fn(),
    };
    const client = new PvmbgClient(payloads);
    const fetchMock = jest.spyOn(global, 'fetch');

    beforeEach(() => {
        written.length = 0;
        jest.clearAllMocks();
    });
    afterAll(() => fetchMock.mockRestore());

    it('returns each record with its raw bytes', async () => {
        const body = Buffer.from('{"data":[{"report_id":"a","x":1.0},{"report_id":"b"}],"meta":{"count":2}}');
        fetchMock.mockResolvedValue(
            new Response(streamOf(body), { status: 200, headers: { 'content-type': 'application/json' } })
        );
        const batch = await client.getVolcanicReports(options);
        expect(batch.failure).toBeUndefined();
        expect(batch.records.map((record) => record.raw.toString())).toEqual([
            '{"report_id":"a","x":1.0}',
            '{"report_id":"b"}',
        ]);
    });

    it.each([
        ['truncated JSON', Buffer.from('{"data":[{"report_id":"a"'), 'malformed_json'],
        ['invalid UTF-8', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]), 'invalid_utf8'],
        ['deep nesting', Buffer.from('{"data":' + '['.repeat(10_000) + ']'.repeat(10_000) + '}'), 'nesting_too_deep'],
        ['wrong envelope', Buffer.from('{"reports":[]}'), 'schema_incompatible'],
    ])('turns %s into a whole-response failure with the exact body', async (_name, body, category) => {
        fetchMock.mockResolvedValue(new Response(streamOf(body), { status: 200 }));
        const batch = await client.getVolcanicReports(options);
        expect(batch.records).toEqual([]);
        expect(batch.failure?.error.category).toBe(category);
        expect(batch.failure?.payload).toEqual({ kind: 'inline', bytes: body });
    });

    it('streams an oversized body to the payload store instead of memory', async () => {
        const body = Buffer.alloc(6 * 1024 * 1024 + 123, 0x5b); // > PVMBG_MAX_BODY_BYTES (5 MiB default)
        fetchMock.mockResolvedValue(new Response(streamOf(body, 256 * 1024), { status: 200 }));
        const batch = await client.getVolcanicReports(options);
        expect(batch.failure?.error.category).toBe('payload_too_large');
        expect(batch.failure?.payload).toEqual({
            kind: 'stored',
            ref: { id: '65f000000000000000000001' },
            size: body.length,
            sha256: createHash('sha256').update(body).digest('hex'),
        });
        expect(Buffer.concat(written).equals(body)).toBe(true);
    });

    it('throws an HTTP status error for non-2xx so the poll fails and retries', async () => {
        fetchMock.mockResolvedValue(new Response('down', { status: 503 }));
        await expect(client.getVolcanicReports(options)).rejects.toMatchObject({
            status: 503,
            message: 'PVMBG request failed with HTTP 503',
        });
    });
});
