import { AsyncContainerModule, interfaces } from 'inversify';
import { TYPES } from '../constants/types';

// Repositories

// Services
import { HealthService } from '../services/health.service';
import { DashboardEventConsumer } from '../services/dashboard-event-consumer.service';
import { MessageSubscriber } from '../services/message-subscriber.service';

export const bindings = new AsyncContainerModule(async (bind: interfaces.Bind) => {
    // Services
    bind<HealthService>(TYPES.HealthService).to(HealthService).inSingletonScope();
    bind<MessageSubscriber>(TYPES.MessageSubscriber).to(MessageSubscriber).inSingletonScope();
    bind<DashboardEventConsumer>(TYPES.DashboardEventConsumer).to(DashboardEventConsumer).inSingletonScope();
});
