import { inject, injectable } from 'inversify';
import { HazardEventMessage } from '../contracts/hazard-event-message';
import { TYPES } from '../constants/types';
import { Notification } from '../db/schema/notifications';
import { INotificationRepository } from '../repositories/notification.repository';

export interface INotificationService {
    apply(message: HazardEventMessage): Promise<'created' | 'ignored' | 'duplicate'>;
    getNotifications(): Promise<Notification[]>;
}

@injectable()
export class NotificationService implements INotificationService {
    constructor(
        @inject(TYPES.INotificationRepository) private readonly notificationRepository: INotificationRepository
    ) {}

    async apply(message: HazardEventMessage): Promise<'created' | 'ignored' | 'duplicate'> {
        return this.notificationRepository.apply(message);
    }

    async getNotifications(): Promise<Notification[]> {
        return this.notificationRepository.findAll();
    }
}
