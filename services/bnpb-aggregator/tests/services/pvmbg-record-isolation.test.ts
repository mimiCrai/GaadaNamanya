import 'reflect-metadata';
import { MongoNetworkError } from 'mongodb';
import { HazardEvent, HazardSeverity, HazardSource, HazardType } from '../../src/db/schema/hazard-events';
import { LeaseLostError } from '../../src/db/schema/background-leases';
import { HazardEventChangeType } from '../../src/db/schema/outbox-events';
import { toRawRecords } from '../../src/libs/safe-decode';
import { IHazardEventRepository } from '../../src/repositories/hazard-event.repository';
import { IPendingTsunamiWarningRepository } from '../../src/repositories/pending-tsunami-warning.repository';
import { HazardEventIngestionService } from '../../src/services/hazard-event-ingestion.service';
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
} as jest.Mocked<IHazardEventRepository>;
const pending = {
    findOldest: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
} as jest.Mocked<IPendingTsunamiWarningRepository>;
const recorder = { record: jest.fn() } as jest.Mocked<IUnprocessedRecorder>;

const good = (id: string) =>
    `{"report_id":"${id}","volcano_id":"MERAPI","alert_level":"Siaga","eruption_count_24h":2,"ash_column_height_m":800.0,"reported_at":"2026-11-12T02:40:11Z"}`;

describe('PVMBG record isolation', () => {
    const service = new HazardEventIngestionService(repository, pending, recorder);

    beforeEach(() => {
        jest.resetAllMocks();
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
        await expect(service.reprocessVolcanicRecord(Buffer.from(good('r-9')), 'corr-9', lease)).resolves.toBe(
            'hz-r-9'
        );
        await expect(service.reprocessVolcanicRecord(Buffer.from('{"report_id":'), 'c', lease)).rejects.toMatchObject({
            category: 'malformed_json',
        });
    });
});
