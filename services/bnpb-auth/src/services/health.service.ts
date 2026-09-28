import { injectable } from 'inversify';
import { pool } from '../db';

export interface HealthStatus {
    status: 'healthy' | 'unhealthy';
    timestamp: string;
    services: {
        database: 'connected' | 'disconnected';
    };
}

@injectable()
export class HealthService {
    async check(): Promise<HealthStatus> {
        let dbStatus: 'connected' | 'disconnected' = 'disconnected';

        try {
            const client = await pool.connect();
            await client.query('SELECT 1');
            client.release();
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
