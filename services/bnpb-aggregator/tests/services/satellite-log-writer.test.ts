import {
    assertConsecutive,
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
