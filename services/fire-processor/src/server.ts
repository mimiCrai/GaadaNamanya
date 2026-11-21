import { shutdownTelemetry } from './telemetry/instrumentation';
import { createApp } from './app';
import { logger } from './libs/logger';
import env from './util/env';

async function main() {
    try {
        const app = await createApp();

        const server = app.listen(env.PORT, () => {
            logger.info({ port: env.PORT, env: env.NODE_ENV }, `🚀 Server started`);
        });
        const shutdown = async () => {
            await shutdownTelemetry().catch(() => undefined);
            server.close(() => process.exit(0));
        };
        process.once('SIGINT', () => void shutdown());
        process.once('SIGTERM', () => void shutdown());
    } catch (error) {
        logger.fatal({ error }, 'Failed to start server');
        process.exit(1);
    }
}

main();
