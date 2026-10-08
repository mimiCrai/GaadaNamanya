// Must be at the top for Inversify decorators to work
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
import './types/locals';

// Import controllers (side-effect: registers routes via decorators)
import './controllers/health.controller';
import './controllers/auth.controller';
import './controllers/admin-users.controller';
import './controllers/public-key.controller';

/**
 * Create and configure the Express application
 */
export async function createApp(): Promise<express.Application> {
    // Set up Inversify container
    const container = new Container();
    await container.loadAsync(bindings);

    // Create base Express app
    const app = express();

    // Disable x-powered-by header for security
    app.disable('x-powered-by');

    // Middleware
    app.use(compression());
    app.use(bodyParser.json({ limit: '5mb' }));
    app.use(bodyParser.urlencoded({ extended: true }));

    app.use((req: Request, res: Response, next: NextFunction) => {
        const correlationId = readCorrelationId(req.header('x-correlation-id'));
        res.locals.correlationId = correlationId;
        res.setHeader('X-Correlation-ID', correlationId);
        logger.info({ method: req.method, path: req.path, correlationId }, 'Incoming request');
        next();
    });

    // OpenAPI validation
    app.use(
        OpenApiValidator.middleware({
            apiSpec: path.join(process.cwd(), 'docs/openapi.yaml'),
            validateRequests: true,
            validateResponses: false, // Set to true for stricter validation
        })
    );

    // Build Inversify Express server
    const server = new InversifyExpressServer(container, null, null, app);

    // Error handling (must be after routes)
    server.setErrorConfig((app) => {
        // OpenAPI validation error handler
        app.use(
            (
                err: Error & { status?: number; errors?: unknown[] },
                req: Request,
                res: Response,
                _next: NextFunction
            ) => {
                logger.error({ err, path: req.path, correlationId: res.locals.correlationId }, 'Request error');

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

function readCorrelationId(value: string | undefined): string {
    return value !== undefined && UUID_PATTERN.test(value) ? value : randomUUID();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
