import { AsyncContainerModule, interfaces } from 'inversify';
import { TYPES } from '../constants/types';

// Repositories

// Services
import { HealthService } from '../services/health.service';
import { HazardGateway, IHazardGateway } from '../services/hazard-gateway.service';
import { IJwtAuthenticator, JwtAuthenticator } from '../services/jwt-authenticator.service';

export const bindings = new AsyncContainerModule(async (bind: interfaces.Bind) => {
    // Services
    bind<HealthService>(TYPES.HealthService).to(HealthService).inSingletonScope();
    bind<IJwtAuthenticator>(TYPES.JwtAuthenticator).to(JwtAuthenticator).inSingletonScope();
    bind<IHazardGateway>(TYPES.HazardGateway).to(HazardGateway).inSingletonScope();
});
