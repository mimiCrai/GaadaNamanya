import { injectable } from 'inversify';

export interface HealthStatus {
    status: 'healthy' | 'unhealthy';
    timestamp: string;
}

export interface IHealthService {
    check(): Promise<HealthStatus>;
    liveness(): Promise<{ status: 'ok' }>;
    readiness(): Promise<{ status: 'ok' | 'error' }>;
}

@injectable()
export class HealthService implements IHealthService {
    async check(): Promise<HealthStatus> {
        return {
            status: 'healthy',
            timestamp: new Date().toISOString(),
        };
    }

    async liveness(): Promise<{ status: 'ok' }> {
        return { status: 'ok' };
    }

    async readiness(): Promise<{ status: 'ok' | 'error' }> {
        return { status: 'ok' };
    }
}
