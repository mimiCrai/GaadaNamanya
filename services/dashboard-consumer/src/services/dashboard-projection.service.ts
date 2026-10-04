import { inject, injectable } from 'inversify';
import { HazardEventMessage } from '../contracts/hazard-event-message';
import { TYPES } from '../constants/types';
import { DashboardHazard } from '../db/schema/dashboard-hazards';
import { IDashboardProjectionRepository } from '../repositories/dashboard-projection.repository';

export interface IDashboardProjectionService {
    apply(message: HazardEventMessage): Promise<boolean>;
    getHazards(): Promise<DashboardHazard[]>;
}

@injectable()
export class DashboardProjectionService implements IDashboardProjectionService {
    constructor(
        @inject(TYPES.IDashboardProjectionRepository)
        private readonly dashboardProjectionRepository: IDashboardProjectionRepository
    ) {}

    async apply(message: HazardEventMessage): Promise<boolean> {
        return this.dashboardProjectionRepository.apply(message);
    }

    async getHazards(): Promise<DashboardHazard[]> {
        return this.dashboardProjectionRepository.findAll();
    }
}
