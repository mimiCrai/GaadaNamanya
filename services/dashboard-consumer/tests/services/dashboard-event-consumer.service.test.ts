import { HazardEventMessage } from '../../src/contracts/hazard-event-message';
import { DashboardEventConsumer } from '../../src/services/dashboard-event-consumer.service';
import { IDashboardProjectionService } from '../../src/services/dashboard-projection.service';
import { IMessageSubscriber, MessageHandler, SubscribeOptions } from '../../src/services/message-subscriber.service';

const message: HazardEventMessage = {
    eventId: '11111111-1111-4111-8111-111111111111',
    eventType: 'hazard.created',
    correlationId: '22222222-2222-4222-8222-222222222222',
    hazard: {
        hazardId: '33333333-3333-4333-8333-333333333333',
        source: 'BMKG',
        sourceRefId: 'bmkg-1',
        hazardType: 'SEISMIC',
        severity: 'SIAGA',
        areaName: 'Aceh',
        latitude: 5.5,
        longitude: 95.3,
        occurredAt: '2026-10-04T10:00:00.000Z',
        ingestedAt: '2026-10-04T10:00:01.000Z',
        attributes: {},
    },
};

describe('DashboardEventConsumer', () => {
    let handler: MessageHandler<unknown>;
    const subscriber: IMessageSubscriber = {
        connect: jest.fn(),
        subscribe: jest.fn(async (_options: SubscribeOptions, callback: MessageHandler<unknown>) => {
            handler = callback;
        }),
        close: jest.fn(),
    };
    const projectionService: IDashboardProjectionService = {
        apply: jest.fn(),
        getHazards: jest.fn(),
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('validates and applies a hazard event to the dashboard projection', async () => {
        (projectionService.apply as jest.Mock).mockResolvedValue(true);
        const consumer = new DashboardEventConsumer(subscriber, projectionService);

        await consumer.start();
        await handler(message);

        expect(subscriber.subscribe).toHaveBeenCalledWith({ topic: expect.any(String) }, expect.any(Function));
        expect(projectionService.apply).toHaveBeenCalledWith(message);
    });

    it('rejects an invalid payload before changing the projection', async () => {
        const consumer = new DashboardEventConsumer(subscriber, projectionService);

        await consumer.start();

        await expect(handler({ eventId: 'not-a-uuid' })).rejects.toThrow();
        expect(projectionService.apply).not.toHaveBeenCalled();
    });

    it('accepts a duplicate event without failing the Kafka handler', async () => {
        (projectionService.apply as jest.Mock).mockResolvedValue(false);
        const consumer = new DashboardEventConsumer(subscriber, projectionService);

        await consumer.start();

        await expect(handler(message)).resolves.toBeUndefined();
        expect(projectionService.apply).toHaveBeenCalledWith(message);
    });

    it('propagates a projection failure so the subscriber does not commit its offset', async () => {
        (projectionService.apply as jest.Mock).mockRejectedValue(new Error('database unavailable'));
        const consumer = new DashboardEventConsumer(subscriber, projectionService);

        await consumer.start();

        await expect(handler(message)).rejects.toThrow('database unavailable');
    });

    it('closes the Kafka subscriber during shutdown', async () => {
        const consumer = new DashboardEventConsumer(subscriber, projectionService);

        await consumer.stop();

        expect(subscriber.close).toHaveBeenCalledTimes(1);
    });
});
