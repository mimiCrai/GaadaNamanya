import { Request, Response } from 'express';
import { NotificationApiController } from '../../src/controllers/notification-api.controller';
import { Notification } from '../../src/db/schema/notifications';
import { INotificationService } from '../../src/services/notification.service';

describe('NotificationApiController', () => {
    it('returns the notification service inbox as data', async () => {
        const notifications: Notification[] = [
            {
                eventId: '11111111-1111-4111-8111-111111111111',
                hazardId: '33333333-3333-4333-8333-333333333333',
                eventType: 'hazard.updated',
                severity: 'AWAS',
                areaName: 'Gunung Merapi',
                title: 'AWAS VOLCANIC hazard',
                message: 'Gunung Merapi has a AWAS hazard update.',
                occurredAt: new Date('2026-10-04T10:00:00.000Z'),
                createdAt: new Date('2026-10-04T10:00:01.000Z'),
            },
        ];
        const notificationService: INotificationService = {
            apply: jest.fn(),
            getNotifications: jest.fn().mockResolvedValue(notifications),
        };
        const response = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        } as unknown as Response;
        const controller = new NotificationApiController(notificationService);

        await controller.getNotifications({} as Request, response);

        expect(response.status).toHaveBeenCalledWith(200);
        expect(response.json).toHaveBeenCalledWith({ data: notifications });
    });
});
