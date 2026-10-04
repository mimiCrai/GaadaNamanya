import { AsyncContainerModule, interfaces } from 'inversify';
import { db } from '../db';
import { TYPES } from '../constants/types';

// Repositories
import { HazardEventRepository, IHazardEventRepository } from '../repositories/hazard-event.repository';
import { ISourceSyncStateRepository, SourceSyncStateRepository } from '../repositories/source-sync-state.repository';

// Services
import { HealthService } from '../services/health.service';
import { HazardEventService, IHazardEventService } from '../services/hazard-event.service';
import { ISourceSyncStateService, SourceSyncStateService } from '../services/source-sync-state.service';
import { MessagePublisher } from '../services/message-publisher.service';

export const bindings = new AsyncContainerModule(async (bind: interfaces.Bind) => {
    // Database
    bind(TYPES.Database).toConstantValue(db);

    // Repositories (bind interface to implementation)
    bind<IHazardEventRepository>(TYPES.IHazardEventRepository).to(HazardEventRepository).inSingletonScope();
    bind<ISourceSyncStateRepository>(TYPES.ISourceSyncStateRepository).to(SourceSyncStateRepository).inSingletonScope();

    // Services (bind interface to implementation)
    bind<HealthService>(TYPES.HealthService).to(HealthService).inSingletonScope();
    bind<IHazardEventService>(TYPES.IHazardEventService).to(HazardEventService).inSingletonScope();
    bind<ISourceSyncStateService>(TYPES.ISourceSyncStateService).to(SourceSyncStateService).inSingletonScope();
    // Message Queue
    bind<MessagePublisher>(TYPES.MessagePublisher).to(MessagePublisher).inSingletonScope();
});
