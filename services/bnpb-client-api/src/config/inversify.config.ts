import { AsyncContainerModule, interfaces } from 'inversify';
import { TYPES } from '../constants/types';

// Repositories

// Services
import { HealthService } from '../services/health.service';

export const bindings = new AsyncContainerModule(async (bind: interfaces.Bind) => {
    // Services
    bind<HealthService>(TYPES.HealthService).to(HealthService).inSingletonScope();
});
