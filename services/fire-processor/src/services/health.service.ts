import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { IFireConsumer } from './fire-consumer.service';

export interface HealthStatus {
    status: 'healthy' | 'unhealthy';
    timestamp: string;
    services?: { kafka: 'consuming' | 'not_consuming'; snapshot: 'restoring' | 'restored' };
}

@injectable()
export class HealthService {
    constructor(@inject(TYPES.IFireConsumer) private readonly consumer: Pick<IFireConsumer, 'status'>) {}

    // the Aggregator is not checked: while it is down the pipeline backs off and nothing is committed
    async check(): Promise<HealthStatus> {
        const runtime = this.consumer.status();
        return {
            status: runtime.ready ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            services: {
                kafka: runtime.ready ? 'consuming' : 'not_consuming',
                snapshot: runtime.restoring ? 'restoring' : 'restored',
            },
        };
    }

    async liveness(): Promise<{ status: 'ok' }> {
        return { status: 'ok' };
    }

    async readiness(): Promise<{ status: 'ok' | 'error' }> {
        return { status: this.consumer.status().ready ? 'ok' : 'error' };
    }
}
