import { AsyncContainerModule, interfaces } from 'inversify';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { TYPES } from '../constants/types';
import { db } from '../db';
import * as schema from '../db/schema';
import { INotificationRepository, NotificationRepository } from '../repositories/notification.repository';
import { HealthService, IHealthService } from '../services/health.service';
import { INotificationEventConsumer, NotificationEventConsumer } from '../services/notification-event-consumer.service';
import { INotificationService, NotificationService } from '../services/notification.service';
import { IMessageSubscriber, MessageSubscriber } from '../services/message-subscriber.service';

export const bindings = new AsyncContainerModule(async (bind: interfaces.Bind) => {
    bind<NodePgDatabase<typeof schema>>(TYPES.Database).toConstantValue(db);
    bind<INotificationRepository>(TYPES.INotificationRepository).to(NotificationRepository).inSingletonScope();
    bind<IHealthService>(TYPES.IHealthService).to(HealthService).inSingletonScope();
    bind<IMessageSubscriber>(TYPES.IMessageSubscriber).to(MessageSubscriber).inSingletonScope();
    bind<INotificationService>(TYPES.INotificationService).to(NotificationService).inSingletonScope();
    bind<INotificationEventConsumer>(TYPES.INotificationEventConsumer).to(NotificationEventConsumer).inSingletonScope();
});
