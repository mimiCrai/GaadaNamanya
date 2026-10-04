import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { INotificationService } from '../services/notification.service';

@controller('/api/notifications')
export class NotificationApiController {
    constructor(@inject(TYPES.INotificationService) private readonly notificationService: INotificationService) {}

    @httpGet('/')
    async getNotifications(_req: Request, res: Response) {
        const notifications = await this.notificationService.getNotifications();
        return res.status(200).json({ data: notifications });
    }
}
