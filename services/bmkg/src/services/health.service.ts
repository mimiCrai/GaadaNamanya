import { injectable } from 'inversify';
import { SERVICE_NAME } from '../libs/logger';

export interface HealthStatus {
    status: 'ok';
    service: string;
    uptime_s: number;
    time: string;
}

// The mock has no external dependencies, so it is healthy whenever it can answer.
@injectable()
export class HealthService {
    check(): HealthStatus {
        return {
            status: 'ok',
            service: SERVICE_NAME,
            uptime_s: Math.round(process.uptime()),
            time: new Date().toISOString(),
        };
    }
}
