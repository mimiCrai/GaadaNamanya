import { createApp, createContainer } from './app';
import { TYPES } from './constants/types';
import { db } from './db';
import { logger } from './libs/logger';
import { IMessagePublisher } from './services/message-publisher.service';
import { IOutboxRelayService } from './services/outbox-relay.service';
import { IPollingService } from './services/polling.service';
import { IStorageTopologyService } from './services/storage-topology.service';
import env from './util/env';
import { IBackgroundLeadershipService } from './services/background-leadership.service';
import { IUnprocessedRetryService } from './services/unprocessed-retry.service';
import { IUnprocessedMessageRepository } from './repositories/unprocessed-message.repository';
import { setUnprocessedCounter } from './libs/metrics';

async function main() {
    try {
        await db.connect();
        const container = await createContainer();
        const app = await createApp(container);
        const server = app.listen(env.PORT, () => {
            logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server started');
        });

        const poller = container.get<IPollingService>(TYPES.IPollingService);
        const outboxRelay = container.get<IOutboxRelayService>(TYPES.IOutboxRelayService);
        const messagePublisher = container.get<IMessagePublisher>(TYPES.IMessagePublisher);
        const leadership = container.get<IBackgroundLeadershipService>(TYPES.IBackgroundLeadershipService);
        const unprocessedRetry = container.get<IUnprocessedRetryService>(TYPES.IUnprocessedRetryService);
        const unprocessedRepository = container.get<IUnprocessedMessageRepository>(TYPES.IUnprocessedMessageRepository);
        setUnprocessedCounter(() => unprocessedRepository.countByStatus());
        leadership.start();
        poller.start();
        outboxRelay.start();
        unprocessedRetry.start();

        let shuttingDown = false;
        const shutdown = async (signal: string) => {
            if (shuttingDown) {
                return;
            }
            shuttingDown = true;
            logger.info({ signal }, 'Shutting down BNPB Aggregator');
            poller.stop();
            outboxRelay.stop();
            unprocessedRetry.stop();
            await leadership.stop();
            await messagePublisher.close();
            await container.get<IStorageTopologyService>(TYPES.IStorageTopologyService).close();
            await db.close();
            server.close(() => process.exit(0));
        };

        process.once('SIGTERM', () => void shutdown('SIGTERM'));
        process.once('SIGINT', () => void shutdown('SIGINT'));
    } catch (error) {
        logger.fatal({ error }, 'Failed to start server');
        process.exit(1);
    }
}

void main();
