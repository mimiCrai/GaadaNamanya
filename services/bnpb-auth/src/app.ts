// Must be at the top for Inversify decorators to work
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

    // Request logging
    app.use((req: Request, _res: Response, next: NextFunction) => {
        logger.info({ method: req.method, path: req.path }, 'Incoming request');
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
