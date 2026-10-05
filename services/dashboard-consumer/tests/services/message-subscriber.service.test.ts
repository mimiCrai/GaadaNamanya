const mockConsumer = {
    connect: jest.fn(),
    subscribe: jest.fn(),
    run: jest.fn(),
    commitOffsets: jest.fn(),
    disconnect: jest.fn(),
};

const mockKafka = {
    consumer: jest.fn(() => mockConsumer),
};

jest.mock('kafkajs', () => ({
    Kafka: jest.fn(() => mockKafka),
}));

import { MessageSubscriber } from '../../src/services/message-subscriber.service';

type EachMessage = (payload: {
    topic: string;
    partition: number;
    message: { offset: string; value: Buffer | null };
}) => Promise<void>;

describe('MessageSubscriber', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('commits the next offset only after a handler succeeds', async () => {
        const subscriber = new MessageSubscriber();
        const handler = jest.fn().mockResolvedValue(undefined);

        await subscriber.subscribe({ topic: 'hazard-events' }, handler);

        expect(mockConsumer.connect).toHaveBeenCalledTimes(1);
        expect(mockConsumer.subscribe).toHaveBeenCalledWith({ topic: 'hazard-events', fromBeginning: false });
        expect(mockConsumer.run).toHaveBeenCalledWith(expect.objectContaining({ autoCommit: false }));

        const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage as EachMessage;
        await eachMessage({
            topic: 'hazard-events',
            partition: 2,
            message: { offset: '7', value: Buffer.from('{"eventId":"event-1"}') },
        });

        expect(handler).toHaveBeenCalledWith({ eventId: 'event-1' });
        expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
            { topic: 'hazard-events', partition: 2, offset: '8' },
        ]);
    });

    it('does not commit when the handler fails', async () => {
        const subscriber = new MessageSubscriber();
        const handler = jest.fn().mockRejectedValue(new Error('projection failed'));

        await subscriber.subscribe({ topic: 'hazard-events' }, handler);
        const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage as EachMessage;

        await expect(
            eachMessage({
                topic: 'hazard-events',
                partition: 0,
                message: { offset: '11', value: Buffer.from('{}') },
            })
        ).rejects.toThrow('projection failed');
        expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
    });

    it('does not commit when the Kafka value is malformed JSON', async () => {
        const subscriber = new MessageSubscriber();

        await subscriber.subscribe({ topic: 'hazard-events' }, jest.fn());
        const eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage as EachMessage;

        await expect(
            eachMessage({
                topic: 'hazard-events',
                partition: 0,
                message: { offset: '11', value: Buffer.from('{not-json') },
            })
        ).rejects.toThrow();
        expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
    });
});
