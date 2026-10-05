import 'reflect-metadata';

import express from 'express';
import compression from 'compression';
import { Container } from 'inversify';
import { InversifyExpressServer } from 'inversify-express-utils';
import { Logger } from 'pino';

import { createBindings } from './config/inversify.config';
import { AppConfig } from './config/env';
import { Clock, TYPES } from './constants/types';
import { createLogger } from './libs/logger';
import { correlationMiddleware } from './middlewares/correlation';
import { errorHandler, notFoundHandler } from './middlewares/errors';
import { requestLogMiddleware } from './middlewares/request-log';
import { GeneratorService } from './services/generator.service';

import './controllers/health.controller';
import './controllers/seismic-event.controller';
import './controllers/tsunami-warning.controller';

export interface AppDependencies {
    logger?: Logger;
    clock?: Clock;
}

export interface BmkgApp {
    app: express.Application;
    container: Container;
    generator: GeneratorService;
    logger: Logger;
}

export function createApp(config: AppConfig, deps: AppDependencies = {}): BmkgApp {
    const logger = deps.logger ?? createLogger({ level: config.logLevel });
    const clock = deps.clock ?? (() => Date.now());

    const container = new Container();
    container.load(createBindings(config, logger, clock));

    const generator = container.get<GeneratorService>(TYPES.GeneratorService);
    generator.seed();

    const app = express();

    app.disable('x-powered-by');

    app.use(correlationMiddleware(logger));
    app.use(requestLogMiddleware);
    app.use(compression());

    const server = new InversifyExpressServer(container, null, null, app);

    server.setErrorConfig((app) => {
        app.use(notFoundHandler);
        app.use(errorHandler);
    });

    return { app: server.build(), container, generator, logger };
}
