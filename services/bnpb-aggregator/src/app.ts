import 'reflect-metadata';

import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import compression from 'compression';
import * as OpenApiValidator from 'express-openapi-validator';
import { Container } from 'inversify';
import { InversifyExpressServer } from 'inversify-express-utils';
import { randomUUID } from 'node:crypto';
import path from 'path';

import { bindings } from './config/inversify.config';
import { logger } from './libs/logger';

import './controllers/health.controller';
import './controllers/hazard-event.controller';

export async function createContainer(): Promise<Container> {
    const container = new Container();
    await container.loadAsync(bindings);
    return container;
}

export async function createApp(existingContainer?: Container): Promise<express.Application> {
    const container = existingContainer ?? (await createContainer());

    const app = express();
    app.disable('x-powered-by');
    app.use(compression());
    app.use(bodyParser.json({ limit: '5mb' }));
    app.use(bodyParser.urlencoded({ extended: true }));

    app.use((req: Request, res: Response, next: NextFunction) => {
        const incoming = req.header('x-correlation-id');
        const correlationId = incoming !== undefined && UUID_PATTERN.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Correlation-ID', correlationId);
        logger.info({ method: req.method, path: req.path, correlationId }, 'Incoming request');
        next();
    });

    app.use(
        OpenApiValidator.middleware({
            apiSpec: path.join(process.cwd(), 'docs/openapi.yaml'),
            validateRequests: true,
            validateResponses: false, // Set to true for stricter validation
        })
    );

    const server = new InversifyExpressServer(container, null, null, app);
    server.setErrorConfig((app) => {
        app.use(
            (
                err: Error & { status?: number; errors?: unknown[] },
                req: Request,
                res: Response,
                _next: NextFunction
            ) => {
                logger.error({ err, path: req.path, correlationId: res.getHeader('X-Correlation-ID') }, 'Request error');

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
