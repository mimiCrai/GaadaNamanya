import { AsyncContainerModule, interfaces } from 'inversify';
import { db } from '../db';
import { TYPES } from '../constants/types';

// Repositories
import { ISessionRepository, SessionRepository } from '../repositories/session.repository';
import { IUserRepository, UserRepository } from '../repositories/user.repository';

// Services
import { HealthService } from '../services/health.service';
import { AuthService, IAuthService } from '../services/auth.service';

export const bindings = new AsyncContainerModule(async (bind: interfaces.Bind) => {
    // Database
    bind(TYPES.Database).toConstantValue(db);

    // Repositories (bind interface to implementation)
    bind<IUserRepository>(TYPES.IUserRepository).to(UserRepository).inSingletonScope();
    bind<ISessionRepository>(TYPES.ISessionRepository).to(SessionRepository).inSingletonScope();

    // Services (bind interface to implementation)
    bind<HealthService>(TYPES.HealthService).to(HealthService).inSingletonScope();
    bind<IAuthService>(TYPES.IAuthService).to(AuthService).inSingletonScope();
});
