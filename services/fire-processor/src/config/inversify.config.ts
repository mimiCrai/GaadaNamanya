import { AsyncContainerModule, interfaces } from 'inversify';
import { AggregatorClient, IAggregatorClient } from '../clients/aggregator.client';
import { TYPES } from '../constants/types';
import { FireConsumer, IFireConsumer } from '../services/fire-consumer.service';
import { HealthService } from '../services/health.service';

export const bindings = new AsyncContainerModule(async (bind: interfaces.Bind) => {
    // the Canonical Store is reached only through the Aggregator (rule 5)
    bind<IAggregatorClient>(TYPES.IAggregatorClient).to(AggregatorClient).inSingletonScope();
    bind<IFireConsumer>(TYPES.IFireConsumer).to(FireConsumer).inSingletonScope();
    bind<HealthService>(TYPES.HealthService).to(HealthService).inSingletonScope();
});
