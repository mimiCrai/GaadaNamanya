import { createApp } from './app';
import { logger } from './libs/logger';
import env from './util/env';

async function main() {
    try {
        const app = await createApp();

        app.listen(env.PORT, () => {
            logger.info({ port: env.PORT, env: env.NODE_ENV }, `🚀 Server started`);
        });
    } catch (error) {
        logger.fatal({ error }, 'Failed to start server');
        process.exit(1);
    }
}

main();
