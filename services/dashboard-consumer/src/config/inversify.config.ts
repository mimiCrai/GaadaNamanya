import { AsyncContainerModule, interfaces } from 'inversify';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { TYPES } from '../constants/types';
import { db } from '../db';
import * as schema from '../db/schema';
import {
    DashboardProjectionRepository,
    IDashboardProjectionRepository,
} from '../repositories/dashboard-projection.repository';
import { DashboardEventConsumer, IDashboardEventConsumer } from '../services/dashboard-event-consumer.service';
import { DashboardProjectionService, IDashboardProjectionService } from '../services/dashboard-projection.service';
import { HealthService, IHealthService } from '../services/health.service';
import { IMessageSubscriber, MessageSubscriber } from '../services/message-subscriber.service';

export const bindings = new AsyncContainerModule(async (bind: interfaces.Bind) => {
    bind<NodePgDatabase<typeof schema>>(TYPES.Database).toConstantValue(db);
    bind<IDashboardProjectionRepository>(TYPES.IDashboardProjectionRepository)
        .to(DashboardProjectionRepository)
        .inSingletonScope();
    bind<IHealthService>(TYPES.IHealthService).to(HealthService).inSingletonScope();
    bind<IMessageSubscriber>(TYPES.IMessageSubscriber).to(MessageSubscriber).inSingletonScope();
    bind<IDashboardProjectionService>(TYPES.IDashboardProjectionService)
        .to(DashboardProjectionService)
        .inSingletonScope();
    bind<IDashboardEventConsumer>(TYPES.IDashboardEventConsumer).to(DashboardEventConsumer).inSingletonScope();
});
