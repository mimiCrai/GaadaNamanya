import { injectable } from 'inversify';
import { db } from '../db';
import env from '../util/env';

export interface HealthStatus {
    status: 'healthy' | 'unhealthy';
    timestamp: string;
    services: {
        database: 'connected' | 'disconnected';
    };
}

export interface IHealthService {
    check(): Promise<HealthStatus>;
    liveness(): Promise<{ status: 'ok' }>;
    readiness(): Promise<{ status: 'ok' | 'error' }>;
}

@injectable()
export class HealthService implements IHealthService {
    async check(): Promise<HealthStatus> {
        let dbStatus: 'connected' | 'disconnected' = 'disconnected';

        try {
            await db.database.command({ ping: 1 }, { timeoutMS: env.LEASE_OPERATION_TIMEOUT_MS });
            dbStatus = 'connected';
        } catch {
            dbStatus = 'disconnected';
        }

        return {
            status: dbStatus === 'connected' ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            services: {
                database: dbStatus,
            },
        };
    }

    async liveness(): Promise<{ status: 'ok' }> {
        return { status: 'ok' };
    }

    async readiness(): Promise<{ status: 'ok' | 'error' }> {
        const health = await this.check();
        return { status: health.status === 'healthy' ? 'ok' : 'error' };
    }
}
