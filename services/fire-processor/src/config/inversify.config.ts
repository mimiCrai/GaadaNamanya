import { AsyncContainerModule, interfaces } from 'inversify';
import { TYPES } from '../constants/types';
import { HealthService } from '../services/health.service';

export const bindings = new AsyncContainerModule(async (bind: interfaces.Bind) => {
    bind<HealthService>(TYPES.HealthService).to(HealthService).inSingletonScope();
});
