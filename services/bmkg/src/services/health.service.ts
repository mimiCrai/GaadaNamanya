import { sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { Database } from '../db';
import { SERVICE_NAME } from '../libs/logger';

export interface HealthStatus {
    status: 'ok' | 'error';
    service: string;
    database: 'connected' | 'disconnected';
    uptime_s: number;
    time: string;
}

@injectable()
export class HealthService {
    constructor(@inject(TYPES.Database) private readonly db: Database) {}

    async check(): Promise<HealthStatus> {
        let database: HealthStatus['database'] = 'connected';
        try {
            await this.db.execute(sql`select 1`);
        } catch {
            database = 'disconnected';
        }

        return {
            status: database === 'connected' ? 'ok' : 'error',
            service: SERVICE_NAME,
            database,
            uptime_s: Math.round(process.uptime()),
            time: new Date().toISOString(),
        };
    }
}
