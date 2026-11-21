import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { IMessageSubscriber } from './message-subscriber.service';

export interface HealthStatus {
    status: 'healthy' | 'unhealthy';
    timestamp: string;
    services: {
        kafka: 'consuming' | 'not_consuming';
    };
}

@injectable()
export class HealthService {
    constructor(@inject(TYPES.IMessageSubscriber) private readonly subscriber: Pick<IMessageSubscriber, 'isRunning'>) {}

    // the Aggregator is deliberately not checked: while it is down the consumer backs off and stays healthy
    async check(): Promise<HealthStatus> {
        const consuming = this.subscriber.isRunning();
        return {
            status: consuming ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            services: { kafka: consuming ? 'consuming' : 'not_consuming' },
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
