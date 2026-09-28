import { injectable } from 'inversify';

export interface HealthStatus {
    status: 'healthy' | 'unhealthy';
    timestamp: string;
}

@injectable()
export class HealthService {
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
