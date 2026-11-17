import 'reflect-metadata';
import { MongoNetworkError } from 'mongodb';
import { HazardEvent, HazardSeverity, HazardSource, HazardType } from '../../src/db/schema/hazard-events';
import { LeaseLostError } from '../../src/db/schema/background-leases';
import { HazardEventChangeType } from '../../src/db/schema/outbox-events';
import { toRawRecords } from '../../src/libs/safe-decode';
import { IHazardEventRepository, isSupersededVersion } from '../../src/repositories/hazard-event.repository';
import { IPendingTsunamiWarningRepository } from '../../src/repositories/pending-tsunami-warning.repository';
import { HazardEventIngestionService, pvmbgVersion } from '../../src/services/hazard-event-ingestion.service';
import { IUnprocessedRecorder } from '../../src/services/unprocessed-recorder.service';

const lease = { ownerId: 'isolation-test', epoch: 3 };
const hazard = (sourceRefId: string): HazardEvent => ({
    hazardId: `hz-${sourceRefId}`,
    source: HazardSource.Pvmbg,
    sourceRefId,
    hazardType: HazardType.Volcanic,
    severity: HazardSeverity.Siaga,
    areaName: 'Gunung Merapi',
    latitude: 0,
    longitude: 0,
    occurredAt: new Date(),
    ingestedAt: new Date(),
    attributes: {},
});

const repository = {
    findAll: jest.fn(),
    findByHazardId: jest.fn(),
    findBySourceAndRefId: jest.fn(),
    upsertAndEnqueue: jest.fn(),
    upsertBatchAndEnqueue: jest.fn(),
} as jest.Mocked<IHazardEventRepository>;
const pending = {
    findOldest: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
} as jest.Mocked<IPendingTsunamiWarningRepository>;
const recorder = { record: jest.fn() } as jest.Mocked<IUnprocessedRecorder>;

const good = (id: string) =>
    `{"report_id":"${id}","volcano_id":"MERAPI","alert_level":"Siaga","eruption_count_24h":2,"ash_column_height_m":800.0,"reported_at":"2026-11-12T02:40:11Z"}`;

const sequences = { next: jest.fn() };

describe('PVMBG record isolation', () => {
    const service = new HazardEventIngestionService(repository, pending, recorder, sequences);

    beforeEach(() => {
        jest.resetAllMocks();
        let seq = 41;
        sequences.next.mockImplementation(async () => ++seq);
        repository.upsertAndEnqueue.mockImplementation(async (input) => ({
            hazardEvent: hazard(input.sourceRefId),
            changeType: HazardEventChangeType.Created,
        }));
        recorder.record.mockResolvedValue({ messageId: 'msg-x', created: true, reopened: false, status: 'parked' });
    });

    it('stores each bad record byte-for-byte and keeps processing the rest', async () => {
        const typeChanged =
            '{"report_id":"r-2","volcano_id":"MERAPI","alert_level":"Siaga","eruption_count_24h":"dua","ash_column_height_m":1,"reported_at":"2026-11-12T02:40:11Z"}';
        const unknownVolcano = good('r-3').replace('MERAPI', 'KRAKATOA_X');
        const body = Buffer.from(
            `{"data":[${good('r-1')},${typeChanged},${unknownVolcano},${good('r-4')}],"meta":{"count":4}}`
        );
        const records = toRawRecords(body, JSON.parse(body.toString()));

        await service.ingestVolcanicBatch({ records, contentType: 'application/json' }, 'corr-1', lease);

        expect(repository.upsertAndEnqueue.mock.calls.map(([input]) => input.sourceRefId)).toEqual(['r-1', 'r-4']);
        expect(recorder.record).toHaveBeenCalledTimes(2);
        const [first, second] = recorder.record.mock.calls.map(([input]) => input);
        expect(first.error.reason).toBe(
            "schema_incompatible: field 'eruption_count_24h' berubah dari number menjadi string"
        );
        expect(first.payload).toEqual({ kind: 'inline', bytes: Buffer.from(typeChanged) });
        expect(first.sourceRefId).toBe('r-2');
        expect(first.context).toEqual({ kind: 'poll.volcanic-report', endpoint: 'GET /volcanic-reports', topic: null });
        expect(second.error.category).toBe('validation_failed');
        expect(second.error.detail).toContain("volcano_id 'KRAKATOA_X'");
        expect(recorder.record.mock.calls[0][1]).toBe(lease);
    });

    it('stores transient write failures as retryable', async () => {
        repository.upsertAndEnqueue.mockRejectedValueOnce(new MongoNetworkError('shard-b down'));
        const records = toRawRecords(Buffer.from(`[${good('r-1')}]`), JSON.parse(`[${good('r-1')}]`));
        await service.ingestVolcanicBatch({ records, contentType: 'application/json' }, 'corr-2', lease);
        const input = recorder.record.mock.calls[0][0];
        expect(input.error.category).toBe('store_unavailable');
        expect(input.error.retryable).toBe(true);
    });

    it('stores an undecodable whole response as one message', async () => {
        const failure = {
            error: new (jest.requireActual('../../src/libs/processing-error').ProcessingError)(
                'malformed_json',
                'JSON terpotong'
            ),
            payload: { kind: 'inline' as const, bytes: Buffer.from('{"data":[{"rep') },
        };
        await service.ingestVolcanicBatch({ records: [], contentType: 'application/json', failure }, 'corr-3', lease);
        expect(recorder.record).toHaveBeenCalledWith(
            expect.objectContaining({
                context: expect.objectContaining({ kind: 'poll.volcanic-response' }),
                payload: failure.payload,
            }),
            lease
        );
    });

    it('propagates lease loss and DLQ store failures so the poll checkpoint does not advance', async () => {
        const records = toRawRecords(Buffer.from(`[${good('r-1')}]`), JSON.parse(`[${good('r-1')}]`));
        repository.upsertAndEnqueue.mockRejectedValueOnce(new LeaseLostError());
        await expect(service.ingestVolcanicBatch({ records, contentType: 'x' }, 'c', lease)).rejects.toBeInstanceOf(
            LeaseLostError
        );
        expect(recorder.record).not.toHaveBeenCalled();

        repository.upsertAndEnqueue.mockRejectedValueOnce(new MongoNetworkError('all shards down'));
        recorder.record.mockRejectedValueOnce(new MongoNetworkError('all shards down'));
        await expect(service.ingestVolcanicBatch({ records, contentType: 'x' }, 'c', lease)).rejects.toThrow(
            'all shards down'
        );
    });

    it('reprocesses a stored record from its raw bytes', async () => {
        const ordering = { seq: 7, index: 2 };
        await expect(
            service.reprocessVolcanicRecord(Buffer.from(good('r-9')), 'corr-9', lease, ordering)
        ).resolves.toEqual({ hazardId: 'hz-r-9', superseded: false });
        await expect(
            service.reprocessVolcanicRecord(Buffer.from('{"report_id":'), 'c', lease, ordering)
        ).rejects.toMatchObject({ category: 'malformed_json' });
    });

    it('review #3 P2: live writes carry reported_at|batch seq|index; the same order is stored with a failure', async () => {
        const typeChanged = good('r-21').replace('"eruption_count_24h":2', '"eruption_count_24h":"dua"');
        const body = Buffer.from(`{"data":[${good('r-20')},${typeChanged},${good('r-22')}]}`);
        await service.ingestVolcanicBatch(
            { records: toRawRecords(body, JSON.parse(body.toString())), contentType: 'application/json' },
            'c',
            lease
        );
        expect(sequences.next).toHaveBeenCalledTimes(1); // one store-issued sequence per batch, no clock
        expect(repository.upsertAndEnqueue.mock.calls.map(([input]) => input.version)).toEqual([
            '2026-11-12T02:40:11.000Z|0000000000000042|000000',
            '2026-11-12T02:40:11.000Z|0000000000000042|000002',
        ]);
        expect(recorder.record.mock.calls[0][0].ordering).toEqual({ seq: 42, index: 1 });
    });

    it('review #3 P2: a replay reuses the stored order, never a timestamp', async () => {
        await service.reprocessVolcanicRecord(Buffer.from(good('r-10')), 'c', lease, { seq: 42, index: 0 });
        expect(repository.upsertAndEnqueue.mock.calls.at(-1)![0].version).toBe(
            '2026-11-12T02:40:11.000Z|0000000000000042|000000'
        );
        await service.reprocessVolcanicRecord(Buffer.from(good('r-10')), 'c', lease, null); // legacy entry
        expect(repository.upsertAndEnqueue.mock.calls.at(-1)![0].version).toBe(
            '2026-11-12T02:40:11.000Z|0000000000000000|000000'
        );
        await service.reprocessVolcanicResponse(Buffer.from(`{"data":[${good('r-30')},${good('r-31')}]}`), 'c', lease, {
            seq: 9,
            index: null,
        });
        expect(repository.upsertAndEnqueue.mock.calls.slice(-2).map(([input]) => input.version)).toEqual([
            '2026-11-12T02:40:11.000Z|0000000000000009|000000',
            '2026-11-12T02:40:11.000Z|0000000000000009|000001',
        ]);
        expect(sequences.next).not.toHaveBeenCalled();
    });

    it('review #3: version order = reported_at, then batch seq, then index (plain string comparison)', () => {
        const v = (reported: string, seq: number, index: number) => pvmbgVersion(new Date(reported), { seq, index });
        expect(v('2026-11-12T10:00:00Z', 900, 0) < v('2026-11-12T10:01:00Z', 1, 0)).toBe(true);
        expect(v('2026-11-12T10:01:00Z', 9, 0) < v('2026-11-12T10:01:00Z', 10, 0)).toBe(true); // not "10" < "9"
        expect(v('2026-11-12T10:01:00Z', 10, 0) < v('2026-11-12T10:01:00Z', 10, 1)).toBe(true); // later in batch
        expect(isSupersededVersion(v('2026-11-12T10:01:00Z', 10, 1), v('2026-11-12T10:01:00Z', 10, 0))).toBe(true);
        expect(isSupersededVersion(undefined, v('2026-11-12T10:00:00Z', 1, 0))).toBe(false);
        expect(isSupersededVersion('x', undefined)).toBe(false);
        const same = v('2026-11-12T10:00:00Z', 3, 0);
        expect(isSupersededVersion(same, same)).toBe(false); // equal = idempotent re-apply, never superseded
    });

    it('review #3 P2: an empty poll takes no sequence value', async () => {
        await service.ingestVolcanicBatch({ records: [], contentType: 'application/json' }, 'c', lease);
        expect(sequences.next).not.toHaveBeenCalled();
    });

    it('review #3: an older report reports superseded instead of failing', async () => {
        repository.upsertAndEnqueue.mockResolvedValueOnce({
            hazardEvent: { hazardId: 'hz-r-12' } as never,
            changeType: null,
            superseded: true,
        });
        await expect(
            service.reprocessVolcanicRecord(Buffer.from(good('r-12')), 'c', lease, { seq: 1, index: 0 })
        ).resolves.toEqual({ hazardId: 'hz-r-12', superseded: true });
        expect(recorder.record).not.toHaveBeenCalled();
    });
});
