import { AsyncContainerModule, interfaces } from 'inversify';
import { db } from '../db';
import { TYPES } from '../constants/types';

// Repositories
import { IItemRepository, ItemRepository } from '../repositories/item.repository';

// Services
import { HealthService } from '../services/health.service';
import { IItemService, ItemService } from '../services/item.service';
import { MessagePublisher } from '../services/message-publisher.service';

export const bindings = new AsyncContainerModule(async (bind: interfaces.Bind) => {
    // Database
    bind(TYPES.Database).toConstantValue(db);

    // Repositories (bind interface to implementation)
    bind<IItemRepository>(TYPES.IItemRepository).to(ItemRepository).inSingletonScope();

    // Services (bind interface to implementation)
    bind<HealthService>(TYPES.HealthService).to(HealthService).inSingletonScope();
    bind<IItemService>(TYPES.IItemService).to(ItemService).inSingletonScope();
    // Message Queue
    bind<MessagePublisher>(TYPES.MessagePublisher).to(MessagePublisher).inSingletonScope();
});
