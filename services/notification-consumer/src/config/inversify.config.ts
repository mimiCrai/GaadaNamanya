import { AsyncContainerModule, interfaces } from 'inversify';
import { TYPES } from '../constants/types';

// Repositories

// Services
import { HealthService } from '../services/health.service';
import { MessageSubscriber } from '../services/message-subscriber.service';
import { NotificationEventConsumer } from '../services/notification-event-consumer.service';

export const bindings = new AsyncContainerModule(async (bind: interfaces.Bind) => {
    // Services
    bind<HealthService>(TYPES.HealthService).to(HealthService).inSingletonScope();
    bind<MessageSubscriber>(TYPES.MessageSubscriber).to(MessageSubscriber).inSingletonScope();
    bind<NotificationEventConsumer>(TYPES.NotificationEventConsumer)
        .to(NotificationEventConsumer)
        .inSingletonScope();
});
