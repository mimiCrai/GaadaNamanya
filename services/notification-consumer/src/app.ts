import 'reflect-metadata';

import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import compression from 'compression';
import * as OpenApiValidator from 'express-openapi-validator';
import { Container } from 'inversify';
import { InversifyExpressServer } from 'inversify-express-utils';
import path from 'path';

import { bindings } from './config/inversify.config';
import { logger } from './libs/logger';

import './controllers/health.controller';
import './controllers/notification.controller';
import './controllers/notification-api.controller';

export async function createContainer(): Promise<Container> {
    const container = new Container();
    await container.loadAsync(bindings);
    return container;
}

export async function createApp(container?: Container): Promise<express.Application> {
    const appContainer = container ?? (await createContainer());

    const app = express();
    app.disable('x-powered-by');
    app.use(compression());
    app.use(bodyParser.json({ limit: '5mb' }));
    app.use(bodyParser.urlencoded({ extended: true }));

    app.use((req: Request, _res: Response, next: NextFunction) => {
        logger.info({ method: req.method, path: req.path }, 'Incoming request');
        next();
    });

    app.use(
        OpenApiValidator.middleware({
            apiSpec: path.join(process.cwd(), 'docs/openapi.yaml'),
            validateRequests: true,
            validateResponses: false, // Set to true for stricter validation
        })
    );

    const server = new InversifyExpressServer(appContainer, null, null, app);
    server.setErrorConfig((app) => {
        app.use(
            (
                err: Error & { status?: number; errors?: unknown[] },
                req: Request,
                res: Response,
                _next: NextFunction
            ) => {
                logger.error({ err, path: req.path }, 'Request error');

                const status = err.status || 500;
                res.status(status).json({
                    error: {
                        message: err.message,
                        ...(err.errors && { details: err.errors }),
                    },
                });
            }
        );
    });

    return server.build();
}
