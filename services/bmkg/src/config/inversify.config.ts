import { ContainerModule, interfaces } from 'inversify';
import { Logger } from 'pino';
import { Clock, TYPES } from '../constants/types';
import { Faker } from '@faker-js/faker';
import { createFaker } from '../libs/faker';
import { Database } from '../db';
import { AppConfig } from './env';

// Repositories
import { EventRepository, IEventRepository } from '../repositories/event.repository';

// Services
import { GeneratorService } from '../services/generator.service';
import { HealthService } from '../services/health.service';

// Middlewares
import { DataAuthMiddleware } from '../middlewares/data-auth.middleware';
import { DelayMiddleware } from '../middlewares/delay.middleware';

export function createBindings(config: AppConfig, db: Database, logger: Logger, clock: Clock): ContainerModule {
    return new ContainerModule((bind: interfaces.Bind) => {
        // Runtime
        bind<AppConfig>(TYPES.Config).toConstantValue(config);
        bind<Logger>(TYPES.Logger).toConstantValue(logger);
        bind<Clock>(TYPES.Clock).toConstantValue(clock);
        bind<Faker>(TYPES.Faker).toConstantValue(createFaker(config.randomSeed));
        bind<Database>(TYPES.Database).toConstantValue(db);

        // Repositories (bind interface to implementation)
        bind<IEventRepository>(TYPES.IEventRepository).to(EventRepository).inSingletonScope();

        // Services
        bind<GeneratorService>(TYPES.GeneratorService).to(GeneratorService).inSingletonScope();
        bind<HealthService>(TYPES.HealthService).to(HealthService).inSingletonScope();

        // Middlewares
        bind<DataAuthMiddleware>(TYPES.DataAuthMiddleware).to(DataAuthMiddleware);
        bind<DelayMiddleware>(TYPES.DelayMiddleware).to(DelayMiddleware);
    });
}
