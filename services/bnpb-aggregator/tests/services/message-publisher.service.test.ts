import { LeaseLostError } from '../../src/db/schema/background-leases';
import { IBackgroundLeaseRepository } from '../../src/repositories/background-lease.repository';
import { MessagePublisher } from '../../src/services/message-publisher.service';
import { Kafka } from 'kafkajs';
import { fencingRejectionsTotal } from '../../src/libs/metrics';

const mockTransaction = { send: jest.fn(), sendBatch: jest.fn(), commit: jest.fn(), abort: jest.fn() };
const mockProducer = { connect: jest.fn(), disconnect: jest.fn(), transaction: jest.fn() };
const mockCreateProducer = jest.fn();
jest.mock('kafkajs', () => ({ Kafka: jest.fn().mockImplementation(() => ({ producer: mockCreateProducer })) }));

describe('Fenced Kafka publisher', () => {
    const lease = { ownerId: 'publisher-test', epoch: 1 };
    const leases = { requireActive: jest.fn() };
    let publisher: MessagePublisher;

    beforeEach(() => {
        jest.resetAllMocks();
        fencingRejectionsTotal.reset();
        (Kafka as jest.Mock).mockImplementation(() => ({ producer: mockCreateProducer }));
        leases.requireActive.mockResolvedValue(new Date());
        mockCreateProducer.mockReturnValue(mockProducer);
        mockProducer.connect.mockResolvedValue(undefined);
        mockProducer.disconnect.mockResolvedValue(undefined);
        mockProducer.transaction.mockResolvedValue(mockTransaction);
        mockTransaction.send.mockResolvedValue([]);
        mockTransaction.sendBatch.mockResolvedValue([]);
        mockTransaction.commit.mockResolvedValue(undefined);
        mockTransaction.abort.mockResolvedValue(undefined);
        publisher = new MessagePublisher(leases as unknown as IBackgroundLeaseRepository);
    });
    afterEach(async () => publisher.close());

    it('uses a stable transactional producer and commits only after revalidating ownership', async () => {
        await publisher.publish({ eventId: 'one' }, { topic: 'hazard-events', key: 'hazard-1' }, lease);
        await publisher.publish({ eventId: 'two' }, { topic: 'hazard-events', key: 'hazard-1' }, lease);
        expect(mockCreateProducer).toHaveBeenCalledTimes(1);
        expect(mockCreateProducer).toHaveBeenCalledWith(
            expect.objectContaining({
                transactionalId: 'bnpb-aggregator-outbox',
                idempotent: true,
                maxInFlightRequests: 1,
            })
        );
        expect(mockTransaction.send).toHaveBeenCalledWith(
            expect.objectContaining({
                acks: -1,
                messages: [expect.objectContaining({ key: 'hazard-1', headers: { fencing_token: '1' } })],
            })
        );
        expect(mockTransaction.commit).toHaveBeenCalledTimes(2);
        expect(leases.requireActive).toHaveBeenCalledTimes(6);
    });

    it('does not create a producer when the lease is already stale', async () => {
        leases.requireActive.mockRejectedValue(new LeaseLostError());
        await expect(publisher.publish({}, { topic: 'hazard-events' }, lease)).rejects.toBeInstanceOf(LeaseLostError);
        expect(mockCreateProducer).not.toHaveBeenCalled();
    });

    it('aborts the transaction when ownership is lost after sending', async () => {
        leases.requireActive
            .mockResolvedValueOnce(new Date())
            .mockResolvedValueOnce(new Date())
            .mockRejectedValueOnce(new LeaseLostError());
        await expect(publisher.publish({}, { topic: 'hazard-events' }, lease)).rejects.toBeInstanceOf(LeaseLostError);
        expect(mockTransaction.abort).toHaveBeenCalled();
        expect(mockTransaction.commit).not.toHaveBeenCalled();
        expect(mockProducer.disconnect).toHaveBeenCalled();
    });

    it('recreates a producer after Kafka fences it instead of retrying a permanently fenced producer', async () => {
        mockProducer.transaction.mockRejectedValueOnce(
            Object.assign(new Error('ProducerFenced'), { type: 'PRODUCER_FENCED' })
        );
        await expect(publisher.publish({}, { topic: 'hazard-events' }, lease)).rejects.toThrow('ProducerFenced');
        await publisher.publish({}, { topic: 'hazard-events' }, lease);
        expect(mockCreateProducer).toHaveBeenCalledTimes(2);
        expect(mockTransaction.commit).toHaveBeenCalledTimes(1);
        expect((await fencingRejectionsTotal.get()).values).toEqual([
            expect.objectContaining({ labels: { backend: 'kafka' }, value: 1 }),
        ]);
    });

    it('drops the producer reference even if disconnect fails', async () => {
        await publisher.publish({}, { topic: 'hazard-events' }, lease);
        mockProducer.disconnect.mockRejectedValueOnce(new Error('connection already closed'));
        await publisher.close();
        await publisher.publish({}, { topic: 'hazard-events' }, lease);
        expect(mockCreateProducer).toHaveBeenCalledTimes(2);
    });

    it('publishes an ordered batch in one fenced transaction', async () => {
        await publisher.publishBatch(
            [
                { message: { eventId: 'one' }, options: { topic: 'hazard-events', key: 'same-hazard' } },
                { message: { eventId: 'two' }, options: { topic: 'hazard-events', key: 'same-hazard' } },
            ],
            lease
        );
        const request = mockTransaction.sendBatch.mock.calls[0][0];
        expect(request.acks).toBe(-1);
        expect(
            request.topicMessages[0].messages.map((item: { value: string }) => JSON.parse(item.value).eventId)
        ).toEqual(['one', 'two']);
        expect(mockTransaction.commit).toHaveBeenCalledTimes(1);
        expect(leases.requireActive).toHaveBeenCalledTimes(3);
    });

    it('does not commit any batch when ownership is lost after sending', async () => {
        leases.requireActive
            .mockResolvedValueOnce(new Date())
            .mockResolvedValueOnce(new Date())
            .mockRejectedValueOnce(new LeaseLostError());
        await expect(
            publisher.publishBatch([{ message: {}, options: { topic: 'hazard-events' } }], lease)
        ).rejects.toBeInstanceOf(LeaseLostError);
        expect(mockTransaction.abort).toHaveBeenCalled();
        expect(mockTransaction.commit).not.toHaveBeenCalled();
    });

    it('splits large batches without reordering messages or committing separate transactions', async () => {
        await publisher.publishBatch(
            Array.from({ length: 80 }, (_, index) => ({
                message: { index, content: 'x'.repeat(10000) },
                options: { topic: 'hazard-events', key: 'same-hazard' },
            })),
            lease
        );
        expect(mockTransaction.sendBatch).toHaveBeenCalledTimes(2);
        expect(mockTransaction.commit).toHaveBeenCalledTimes(1);
        const indices = mockTransaction.sendBatch.mock.calls.flatMap(([request]) =>
            request.topicMessages[0].messages.map((item: { value: string }) => JSON.parse(item.value).index)
        );
        expect(indices).toEqual(Array.from({ length: 80 }, (_, index) => index));
    });
});
