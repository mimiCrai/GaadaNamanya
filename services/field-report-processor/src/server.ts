import { shutdownTelemetry } from './telemetry/instrumentation';
import { createApp, createContainer } from './app';
import { TYPES } from './constants/types';
import { logger } from './libs/logger';
import { IFieldReportConsumer } from './services/field-report-consumer.service';
import env from './util/env';

async function main() {
    try {
        const container = await createContainer();
        const app = await createApp(container);
        const consumer = container.get<IFieldReportConsumer>(TYPES.IFieldReportConsumer);

        const server = app.listen(env.PORT, () => {
            logger.info({ port: env.PORT, env: env.NODE_ENV }, `🚀 Server started`);
        });
        // Kafka may still be starting: keep retrying instead of exiting (health stays live, readiness reports it)
        void (async () => {
            for (let attempt = 1; ; attempt++) {
                try {
                    await consumer.start();
                    return;
                } catch (error) {
                    logger.warn({ error, attempt }, 'Field report consumer could not start; retrying');
                    await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * attempt)));
                }
            }
        })();

        const shutdown = async (signal: string) => {
            logger.info({ signal }, 'Shutting down field report processor');
            await consumer.stop();
            await shutdownTelemetry().catch(() => undefined);
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
