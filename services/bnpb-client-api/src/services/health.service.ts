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

    // D-43: Kafka only gates POST /field-reports (503 + Retry-After there), never the read path, so it stays out of readiness
    async readiness(): Promise<{ status: 'ok'; field_reports?: 'connected' | 'connecting' }> {
        if (!this.publisher) return { status: 'ok' };
        return { status: 'ok', field_reports: this.publisher.isReady() ? 'connected' : 'connecting' };
    }
}
