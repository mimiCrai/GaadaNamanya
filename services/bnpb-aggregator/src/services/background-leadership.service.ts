import { inject, injectable } from 'inversify';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { TYPES } from '../constants/types';
import { LeaseToken } from '../db/schema/background-leases';
import { logger } from '../libs/logger';
import { IBackgroundLeaseRepository } from '../repositories/background-lease.repository';
import env from '../util/env';

export interface IBackgroundLeadershipService {
    readonly instanceId: string;
    start(): void;
    stop(): Promise<void>;
    current(): LeaseToken | null;
    invalidate(token: LeaseToken): void;
}

@injectable()
export class BackgroundLeadershipService implements IBackgroundLeadershipService {
    readonly instanceId = `${hostname()}:${process.pid}:${randomUUID()}`;
    private token: LeaseToken | null = null;
    private timer: NodeJS.Timeout | undefined;
    private stopped = true;
    private pending: Promise<void> | undefined;

    constructor(@inject(TYPES.IBackgroundLeaseRepository) private readonly leases: IBackgroundLeaseRepository) {}

    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        this.schedule(0);
    }

    current(): LeaseToken | null {
        return this.stopped || !this.token ? null : { ...this.token };
    }

    invalidate(token: LeaseToken): void {
        if (this.token?.ownerId === token.ownerId && this.token.epoch === token.epoch) this.token = null;
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        await this.pending;
        const token = this.token;
        this.token = null;
        if (token)
            await this.leases
                .release(token)
                .catch((error) =>
                    logger.warn({ error, instanceId: this.instanceId }, 'Lease release failed; it will expire')
                );
    }

    private schedule(delay: number): void {
        this.timer = setTimeout(() => {
            this.pending = this.refresh().finally(() => {
                this.pending = undefined;
                if (!this.stopped) this.schedule(env.BACKGROUND_LEASE_RENEW_MS);
            });
        }, delay);
    }

    private async refresh(): Promise<void> {
        try {
            const lease = await this.leases.acquireOrRenew(this.instanceId);
            const previous = this.token;
            this.token = lease ? { ownerId: this.instanceId, epoch: lease.epoch } : null;
            if (this.token?.epoch !== previous?.epoch || Boolean(this.token) !== Boolean(previous)) {
                logger.info(
                    { instanceId: this.instanceId, epoch: this.token?.epoch, leader: Boolean(this.token) },
                    'Background leadership changed'
                );
            }
        } catch (error) {
            this.token = null;
            logger.warn(
                { error, instanceId: this.instanceId },
                'Cannot verify background leadership; work is disabled'
            );
        }
    }
}
