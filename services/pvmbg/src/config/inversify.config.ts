import { ContainerModule, interfaces } from 'inversify';
import { Logger } from 'pino';
import { Clock, TYPES } from '../constants/types';
import { Faker } from '@faker-js/faker';
import { createFaker } from '../libs/faker';
import { AppConfig } from './env';

// Repositories
import { IReportStore, ReportStore } from '../repositories/report.store';

// Services
import { GeneratorService } from '../services/generator.service';
import { HealthService } from '../services/health.service';
import { OutageService } from '../services/outage.service';
import { SchemaService } from '../services/schema.service';

// Middlewares
import { DataAuthMiddleware } from '../middlewares/data-auth.middleware';
import { DelayMiddleware } from '../middlewares/delay.middleware';
import { OutageMiddleware } from '../middlewares/outage.middleware';

export function createBindings(config: AppConfig, logger: Logger, clock: Clock): ContainerModule {
    return new ContainerModule((bind: interfaces.Bind) => {
        // Runtime
        bind<AppConfig>(TYPES.Config).toConstantValue(config);
        bind<Logger>(TYPES.Logger).toConstantValue(logger);
        bind<Clock>(TYPES.Clock).toConstantValue(clock);
        bind<Faker>(TYPES.Faker).toConstantValue(createFaker(config.randomSeed));

        // Repositories (bind interface to implementation)
        bind<IReportStore>(TYPES.IReportStore).to(ReportStore).inSingletonScope();

        // Services (runtime state lives in singletons)
        bind<GeneratorService>(TYPES.GeneratorService).to(GeneratorService).inSingletonScope();
        bind<SchemaService>(TYPES.SchemaService).to(SchemaService).inSingletonScope();
        bind<OutageService>(TYPES.OutageService).to(OutageService).inSingletonScope();
        bind<HealthService>(TYPES.HealthService).to(HealthService).inSingletonScope();

        // Middlewares
        bind<OutageMiddleware>(TYPES.OutageMiddleware).to(OutageMiddleware);
        bind<DataAuthMiddleware>(TYPES.DataAuthMiddleware).to(DataAuthMiddleware);
        bind<DelayMiddleware>(TYPES.DelayMiddleware).to(DelayMiddleware);
    });
}
