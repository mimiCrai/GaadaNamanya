import { HazardEventMessage } from '../../src/contracts/hazard-event-message';
import { NotificationEventConsumer } from '../../src/services/notification-event-consumer.service';
import { INotificationService } from '../../src/services/notification.service';
import { IMessageSubscriber, MessageHandler, SubscribeOptions } from '../../src/services/message-subscriber.service';

const message: HazardEventMessage = {
    eventId: '11111111-1111-4111-8111-111111111111',
    eventType: 'hazard.updated',
    correlationId: '22222222-2222-4222-8222-222222222222',
    hazard: {
        hazardId: '33333333-3333-4333-8333-333333333333',
        source: 'PVMBG',
        sourceRefId: 'pvmbg-1',
        hazardType: 'VOLCANIC',
        severity: 'AWAS',
        areaName: 'Gunung Merapi',
        latitude: -7.54,
        longitude: 110.44,
        occurredAt: '2026-10-04T10:00:00.000Z',
        ingestedAt: '2026-10-04T10:00:01.000Z',
        attributes: {},
    },
};

describe('NotificationEventConsumer', () => {
    let handler: MessageHandler<unknown>;
    const subscriber: IMessageSubscriber = {
        connect: jest.fn(),
        subscribe: jest.fn(async (_options: SubscribeOptions, callback: MessageHandler<unknown>) => {
            handler = callback;
        }),
        close: jest.fn(),
    };
    const notificationService: INotificationService = {
        apply: jest.fn(),
        getNotifications: jest.fn(),
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('validates and applies a hazard event to the notification inbox', async () => {
        (notificationService.apply as jest.Mock).mockResolvedValue('created');
        const consumer = new NotificationEventConsumer(subscriber, notificationService);

        await consumer.start();
        await handler(message);

        expect(subscriber.subscribe).toHaveBeenCalledWith({ topic: expect.any(String) }, expect.any(Function));
        expect(notificationService.apply).toHaveBeenCalledWith(message);
    });

    it('rejects an invalid payload before changing the notification inbox', async () => {
        const consumer = new NotificationEventConsumer(subscriber, notificationService);

        await consumer.start();

        await expect(handler({ eventId: 'not-a-uuid' })).rejects.toThrow();
        expect(notificationService.apply).not.toHaveBeenCalled();
    });

    it.each(['ignored', 'duplicate'] as const)(
        'accepts a %s event without failing the Kafka handler',
        async (result) => {
            (notificationService.apply as jest.Mock).mockResolvedValue(result);
            const consumer = new NotificationEventConsumer(subscriber, notificationService);

            await consumer.start();

            await expect(handler(message)).resolves.toBeUndefined();
            expect(notificationService.apply).toHaveBeenCalledWith(message);
        }
    );

    it('propagates a notification-store failure so the subscriber does not commit its offset', async () => {
        (notificationService.apply as jest.Mock).mockRejectedValue(new Error('database unavailable'));
        const consumer = new NotificationEventConsumer(subscriber, notificationService);

        await consumer.start();

        await expect(handler(message)).rejects.toThrow('database unavailable');
    });

    it('closes the Kafka subscriber during shutdown', async () => {
        const consumer = new NotificationEventConsumer(subscriber, notificationService);

        await consumer.stop();

        expect(subscriber.close).toHaveBeenCalledTimes(1);
    });
});
