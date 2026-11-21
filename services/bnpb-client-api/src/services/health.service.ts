import { inject, injectable, optional } from 'inversify';
import { TYPES } from '../constants/types';
import { IFieldReportPublisher } from './field-report-publisher.service';

export interface HealthStatus {
    status: 'healthy' | 'unhealthy';
    timestamp: string;
}

@injectable()
export class HealthService {
    constructor(
        @inject(TYPES.FieldReportPublisher) @optional() private readonly publisher?: Pick<IFieldReportPublisher, 'isReady'>
    ) {}

    async check(): Promise<HealthStatus> {
        return {
            status: 'healthy',
            timestamp: new Date().toISOString(),
        };
    }

    async liveness(): Promise<{ status: 'ok' }> {
        return { status: 'ok' };
    }

    // D-38: not ready until the field report producer is connected, so no 503 right after a restart
    async readiness(): Promise<{ status: 'ok' | 'error'; field_reports?: 'connected' | 'connecting' }> {
        if (!this.publisher) return { status: 'ok' };
        const ready = this.publisher.isReady();
        return { status: ready ? 'ok' : 'error', field_reports: ready ? 'connected' : 'connecting' };
    }
}
