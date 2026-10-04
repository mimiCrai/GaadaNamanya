import { createApp, createContainer } from './app';
import { TYPES } from './constants/types';
import { logger } from './libs/logger';
import { NotificationEventConsumer } from './services/notification-event-consumer.service';
import env from './util/env';

async function main() {
    try {
        const container = await createContainer();
        const app = await createApp(container);
        const eventConsumer = container.get<NotificationEventConsumer>(TYPES.NotificationEventConsumer);

        await eventConsumer.start();

        const server = app.listen(env.PORT, () => {
            logger.info({ port: env.PORT, env: env.NODE_ENV }, `🚀 Server started`);
        });

        const shutdown = async (signal: string) => {
            logger.info({ signal }, 'Shutting down notification consumer');
            await eventConsumer.stop();
            server.close(() => process.exit(0));
        };

        process.once('SIGINT', () => void shutdown('SIGINT'));
        process.once('SIGTERM', () => void shutdown('SIGTERM'));
    } catch (error) {
        logger.fatal({ error }, 'Failed to start server');
        process.exit(1);
    }
}

main();
