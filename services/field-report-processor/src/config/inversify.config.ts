import { AsyncContainerModule, interfaces } from 'inversify';
import { TYPES } from '../constants/types';

// Clients
import { AggregatorClient, IAggregatorClient } from '../clients/aggregator.client';

// Services
import { HealthService } from '../services/health.service';
import { FieldReportConsumer, IFieldReportConsumer } from '../services/field-report-consumer.service';
import { IMessageSubscriber, MessageSubscriber } from '../services/message-subscriber.service';

export const bindings = new AsyncContainerModule(async (bind: interfaces.Bind) => {
    // Clients (the Canonical Store is reached only through the Aggregator, rule 5)
    bind<IAggregatorClient>(TYPES.IAggregatorClient).to(AggregatorClient).inSingletonScope();

    // Services (bind interface to implementation)
    bind<HealthService>(TYPES.HealthService).to(HealthService).inSingletonScope();
    bind<IFieldReportConsumer>(TYPES.IFieldReportConsumer).to(FieldReportConsumer).inSingletonScope();

    // Message Queue
    bind<IMessageSubscriber>(TYPES.IMessageSubscriber).to(MessageSubscriber).inSingletonScope();
});
