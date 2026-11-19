import {
    assertConsecutive,
    assertContinuesCheckpoint,
    SatelliteContinuityError,
    tailScanWindows,
    chunkByBytes,
    encodedMessageBytes,
    effectiveRecordLimit,
    RECORD_BATCH_OVERHEAD_BYTES,
    encodeRawRecord,
    isFencedError,
    isRetriableKafkaError,
    withKafkaRetry,
    SatelliteRawRecord,
} from '../../src/services/satellite-log-writer.service';

const lease = { ownerId: 'host:1:abc', epoch: 7 };

function record(offset: number, overrides: Partial<SatelliteRawRecord> = {}): SatelliteRawRecord {
    return { offset, kind: 'detection', receivedAt: '2026-11-15T00:00:00.000Z', correlationId: 'c-1', ...overrides };
}

describe('encodeRawRecord', () => {
    it('keeps tracing in Kafka headers and includes it in the encoded byte budget', () => {
        const raw = record(17, { dataRaw: '{"offset":17,"frp":367.0}' });
        const carrier = { traceparent: '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01' };
        const plain = encodeRawRecord(raw, lease);
        const traced = encodeRawRecord(raw, lease, carrier);
        expect(traced.value).toBe(plain.value);
        expect(traced.headers).toMatchObject(carrier);
        expect(encodedMessageBytes(traced) - encodedMessageBytes(plain)).toBe(
            Buffer.byteLength('traceparent') + Buffer.byteLength(carrier.traceparent)
        );
    });
    it('keys by offset and keeps the raw data text untouched', () => {
        const message = encodeRawRecord(record(17, { dataRaw: '{"offset":17,"frp":367.0}' }), lease);
        expect(message.key).toBe('17');
        expect(message.headers).toEqual({
            feed_offset: '17',
            kind: 'detection',
            fencing_token: '7',
            instance_id: 'host:1:abc',
            correlation_id: 'c-1',
        });
        const value = JSON.parse(String(message.value));
        expect(value).toEqual({
            v: 1,
            offset: 17,
            kind: 'detection',
            received_at: '2026-11-15T00:00:00.000Z',
            data_raw: '{"offset":17,"frp":367.0}',
        });
        expect(JSON.parse(value.data_raw).frp).toBe(367);
        expect(String(message.value)).toContain('367.0');
    });

    it('encodes heartbeat and unprocessed control records', () => {
        const heartbeat = JSON.parse(
            String(
                encodeRawRecord(
                    record(5, { kind: 'heartbeat', virtualNow: '2026-11-15T00:16:00Z', dataRaw: '{}' }),
                    lease
                ).value
            )
        );
        expect(heartbeat.virtual_now).toBe('2026-11-15T00:16:00Z');
        const broken = JSON.parse(
            String(
                encodeRawRecord(
                    record(6, { kind: 'unprocessed', messageId: 'msg-1', reason: 'malformed_json: x' }),
                    lease
                ).value
            )
        );
        expect(broken).toMatchObject({ kind: 'unprocessed', message_id: 'msg-1', reason: 'malformed_json: x' });
        expect(broken.data_raw).toBeUndefined();
    });
});

describe('assertConsecutive', () => {
    it('accepts ascending-by-one batches and rejects anything else', () => {
        expect(() => assertConsecutive([record(1), record(2), record(3)])).not.toThrow();
        expect(() => assertConsecutive([record(1), record(3)])).toThrow(/not consecutive/);
        expect(() => assertConsecutive([record(2), record(2)])).toThrow(/not consecutive/);
    });
});

describe('assertContinuesCheckpoint (review #1)', () => {
    it('only accepts a batch that starts at the durable checkpoint', () => {
        expect(() => assertContinuesCheckpoint([record(3), record(4)], 3)).not.toThrow();
        expect(() => assertContinuesCheckpoint([], null)).not.toThrow();
        expect(() => assertContinuesCheckpoint([record(1), record(2)], 0)).toThrow(SatelliteContinuityError);
        expect(() => assertContinuesCheckpoint([record(0)], 1)).toThrow(/expected 1/);
        expect(() => assertContinuesCheckpoint([record(0)], null)).toThrow(/before the checkpoint was read/);
    });
});

describe('byte budget (review #4)', () => {
    const message = (offset: number, bytes: number) =>
        encodeRawRecord(record(offset, { dataRaw: 'p'.repeat(bytes) }), lease);

    it('splits in order so no chunk exceeds the budget, one oversized message alone in its chunk', () => {
        const messages = [message(0, 600_000), message(1, 600_000), message(2, 10), message(3, 10)];
        const chunks = chunkByBytes(messages, 900 * 1024);
        expect(chunks.map((chunk) => chunk.map((m) => m.key))).toEqual([['0'], ['1', '2', '3']]);
        for (const chunk of chunks) {
            expect(chunk.reduce((sum, m) => sum + encodedMessageBytes(m), 0)).toBeLessThanOrEqual(900 * 1024);
        }
        expect(chunkByBytes([message(0, 5_000)], 1_024).map((c) => c.length)).toEqual([1]);
        expect(chunkByBytes([], 1_024)).toEqual([]);
    });

    it('counts key, value and headers in bytes (UTF-8), not characters', () => {
        const ascii = encodedMessageBytes(encodeRawRecord(record(1, { dataRaw: 'aaaa' }), lease));
        const multibyte = encodedMessageBytes(encodeRawRecord(record(1, { dataRaw: 'éééé' }), lease));
        expect(multibyte - ascii).toBe(4);
    });

    it('never lets the configured budget exceed what the topic accepts', () => {
        expect(effectiveRecordLimit(900 * 1024, 1_048_588)).toBe(900 * 1024);
        expect(effectiveRecordLimit(4 * 1024 * 1024, 1_048_588)).toBe(1_048_588 - RECORD_BATCH_OVERHEAD_BYTES);
        expect(effectiveRecordLimit(4 * 1024 * 1024, 8 * 1024 * 1024)).toBe(4 * 1024 * 1024);
    });
});

describe('tailScanWindows (review #2)', () => {
    it('walks backwards from the end in doubling windows until low, without overlap or holes', () => {
        expect(tailScanWindows(0, 2, 1_000)).toEqual([[0, 2]]);
        expect(tailScanWindows(0, 20, 4)).toEqual([
            [16, 20],
            [8, 16],
            [0, 8],
        ]);
        expect(tailScanWindows(5, 9, 2)).toEqual([
            [7, 9],
            [5, 7],
        ]);
        expect(tailScanWindows(3, 3, 10)).toEqual([]);
    });
});

describe('isFencedError', () => {
    it('recognises kafkajs fencing errors, also when wrapped', () => {
        expect(isFencedError({ type: 'PRODUCER_FENCED' })).toBe(true);
        expect(
            isFencedError({ name: 'KafkaJSNumberOfRetriesExceeded', originalError: { type: 'INVALID_PRODUCER_EPOCH' } })
        ).toBe(true);
        expect(isFencedError(new Error('x', { cause: { type: 'PRODUCER_FENCED' } }))).toBe(true);
        expect(isFencedError({ type: 'KAFKA_UNKNOWN_ERROR', code: 90 })).toBe(true);
        expect(isFencedError({ type: 'REQUEST_TIMED_OUT', code: 7 })).toBe(false);
        expect(isFencedError(undefined)).toBe(false);
    });
});

describe('withKafkaRetry', () => {
    it('retries coordinator errors and gives up on other errors', async () => {
        const notCoordinator = Object.assign(new Error('not coordinator'), { type: 'NOT_COORDINATOR' });
        let calls = 0;
        await expect(
            withKafkaRetry(
                async () => {
                    calls++;
                    if (calls < 3) throw notCoordinator;
                    return 'ok';
                },
                5,
                1
            )
        ).resolves.toBe('ok');
        expect(calls).toBe(3);

        calls = 0;
        const fatal = new Error('topic authorization failed');
        await expect(
            withKafkaRetry(
                async () => {
                    calls++;
                    throw fatal;
                },
                5,
                1
            )
        ).rejects.toBe(fatal);
        expect(calls).toBe(1);

        await expect(withKafkaRetry(async () => Promise.reject(notCoordinator), 3, 1)).rejects.toBe(notCoordinator);
    });

    it('classifies kafkajs retriable errors, also when wrapped', () => {
        expect(isRetriableKafkaError({ type: 'COORDINATOR_LOAD_IN_PROGRESS' })).toBe(true);
        expect(isRetriableKafkaError({ retriable: true })).toBe(true);
        expect(isRetriableKafkaError({ originalError: { type: 'NOT_COORDINATOR' } })).toBe(true);
        expect(isRetriableKafkaError({ type: 'INVALID_PRODUCER_EPOCH', retriable: false })).toBe(false);
    });
});
