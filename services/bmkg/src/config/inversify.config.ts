import { ContainerModule, interfaces } from 'inversify';
import { Logger } from 'pino';
import { Clock, TYPES } from '../constants/types';
import { Faker } from '@faker-js/faker';
import { createFaker } from '../libs/faker';
import { AppConfig } from './env';

// Repositories
import { EventStore, IEventStore } from '../repositories/event.store';

// Services
import { GeneratorService } from '../services/generator.service';
import { HealthService } from '../services/health.service';

// Middlewares
import { DataAuthMiddleware } from '../middlewares/data-auth.middleware';
import { DelayMiddleware } from '../middlewares/delay.middleware';

export function createBindings(config: AppConfig, logger: Logger, clock: Clock): ContainerModule {
    return new ContainerModule((bind: interfaces.Bind) => {
        // Runtime
        bind<AppConfig>(TYPES.Config).toConstantValue(config);
        bind<Logger>(TYPES.Logger).toConstantValue(logger);
        bind<Clock>(TYPES.Clock).toConstantValue(clock);
        bind<Faker>(TYPES.Faker).toConstantValue(createFaker(config.randomSeed));

        // Repositories (bind interface to implementation)
        bind<IEventStore>(TYPES.IEventStore).to(EventStore).inSingletonScope();

        // Services
        bind<GeneratorService>(TYPES.GeneratorService).to(GeneratorService).inSingletonScope();
        bind<HealthService>(TYPES.HealthService).to(HealthService).inSingletonScope();

        // Middlewares
        bind<DataAuthMiddleware>(TYPES.DataAuthMiddleware).to(DataAuthMiddleware);
        bind<DelayMiddleware>(TYPES.DelayMiddleware).to(DelayMiddleware);
    });
}
