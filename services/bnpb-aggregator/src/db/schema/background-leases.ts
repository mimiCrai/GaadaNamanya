export const backgroundLeases = 'background_leases';
export const backgroundLeaseId = 'aggregator-background';

export interface LeaseToken {
    ownerId: string;
    epoch: number;
}

export interface BackgroundLease {
    ownerId: string | null;
    epoch: number;
    expiresAt: Date;
    checkedAt: Date;
    guardVersion: number;
}

export class LeaseLostError extends Error {
    constructor() {
        super('Background lease is no longer active');
    }
}
