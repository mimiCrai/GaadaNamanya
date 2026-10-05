import { createApp, createContainer } from './app';
import { TYPES } from './constants/types';
import { pool } from './db';
import { logger } from './libs/logger';
import { IMessagePublisher } from './services/message-publisher.service';
import { IOutboxRelayService } from './services/outbox-relay.service';
import { IPollingService } from './services/polling.service';
import env from './util/env';

async function main() {
    try {
        const container = await createContainer();
        const app = await createApp(container);
        const server = app.listen(env.PORT, () => {
            logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server started');
        });

        const poller = container.get<IPollingService>(TYPES.IPollingService);
        const outboxRelay = container.get<IOutboxRelayService>(TYPES.IOutboxRelayService);
        const messagePublisher = container.get<IMessagePublisher>(TYPES.IMessagePublisher);
        poller.start();
        outboxRelay.start();

        let shuttingDown = false;
        const shutdown = async (signal: string) => {
            if (shuttingDown) {
                return;
            }
            shuttingDown = true;
            logger.info({ signal }, 'Shutting down BNPB Aggregator');
            poller.stop();
            outboxRelay.stop();
            await messagePublisher.close();
            await pool.end();
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
