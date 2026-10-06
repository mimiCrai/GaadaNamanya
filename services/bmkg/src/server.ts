import { ZodError } from 'zod';
import { createApp } from './app';
import { AppConfig, loadConfig } from './config/env';
import { createDatabase } from './db';
import { createLogger } from './libs/logger';

function readConfig(): AppConfig {
    try {
        return loadConfig();
    } catch (error) {
        const issues =
            error instanceof ZodError
                ? error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
                : undefined;
        createLogger().fatal({ issues, err: issues ? undefined : error }, 'Invalid configuration');
        process.exit(1);
    }
}

async function main() {
    const config = readConfig();
    const { db, pool } = createDatabase(config.databaseUrl, config.nodeEnv);

    let started;
    try {
        started = await createApp(config, db);
    } catch (error) {
        createLogger().fatal({ err: error }, 'Failed to start BMKG mock (is the database reachable and migrated?)');
        await pool.end();
        process.exit(1);
    }
    const { app, generator, logger } = started;

    const server = app.listen(config.port, () => {
        logger.info(
            {
                port: config.port,
                env: config.nodeEnv,
                delay_ms: [config.delayMinMs, config.delayMaxMs],
                event_interval_ms: config.eventIntervalMs,
                warning_lag_ms: config.warningLagMs,
                api_key_count: config.apiKeys.length,
                random_seed: config.randomSeed !== undefined,
            },
            'BMKG mock started'
        );
        generator.start();
    });

    const shutdown = (signal: string) => {
        logger.info({ signal }, 'Shutting down');
        generator.stop();
        server.close(() => {
            pool.end().finally(() => process.exit(0));
        });
        setTimeout(() => process.exit(0), 5_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
