import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { HazardEvent } from '../db/schema/hazard-events';
import { IHazardEventRepository } from '../repositories/hazard-event.repository';
import { ISourceSyncStateService, PollingStatus } from './source-sync-state.service';

export interface IHazardEventService {
    getAllHazardEvents(): Promise<HazardEvent[]>;
    getHazardEventById(hazardId: string): Promise<HazardEvent | null>;
    getPollingStatus(): Promise<Record<string, PollingStatus>>;
}

@injectable()
export class HazardEventService implements IHazardEventService {
    constructor(
        @inject(TYPES.IHazardEventRepository) private readonly hazardEventRepository: IHazardEventRepository,
        @inject(TYPES.ISourceSyncStateService) private readonly sourceSyncStateService: ISourceSyncStateService
    ) {}

    async getAllHazardEvents(): Promise<HazardEvent[]> {
        return this.hazardEventRepository.findAll();
    }

    async getHazardEventById(hazardId: string): Promise<HazardEvent | null> {
        return (await this.hazardEventRepository.findByHazardId(hazardId)) ?? null;
    }

    async getPollingStatus(): Promise<Record<string, PollingStatus>> {
        return this.sourceSyncStateService.getPollingStatus();
    }
}
