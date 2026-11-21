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
import { ISatelliteIngestService } from './services/satellite-ingest.service';
import { ISensorPantaiService } from './services/sensor-pantai.service';
import { IPvmbgMappingService } from './services/pvmbg-mapping.service';

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
        const satelliteIngest = container.get<ISatelliteIngestService>(TYPES.ISatelliteIngestService);
        const unprocessedRepository = container.get<IUnprocessedMessageRepository>(TYPES.IUnprocessedMessageRepository);
        const sensorPantai = container.get<ISensorPantaiService>(TYPES.ISensorPantaiService);
        const pvmbgMapping = container.get<IPvmbgMappingService>(TYPES.IPvmbgMappingService);
        setUnprocessedCounter(() => unprocessedRepository.countByStatus());
        // every replica, not leader-only: the leader can change at any time (D-36)
        pvmbgMapping.start();
        leadership.start();
        poller.start();
        outboxRelay.start();
        unprocessedRetry.start();
        satelliteIngest.start();
        sensorPantai.start();

        let shuttingDown = false;
        const shutdown = async (signal: string) => {
            if (shuttingDown) {
                return;
            }
            shuttingDown = true;
            logger.info({ signal }, 'Shutting down BNPB Aggregator');
            poller.stop();
            pvmbgMapping.stop();
            outboxRelay.stop();
            unprocessedRetry.stop();
            // Close the feed stream before releasing the lease, so the next leader is not answered 429.
            await satelliteIngest.stop();
            sensorPantai.stop();
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
