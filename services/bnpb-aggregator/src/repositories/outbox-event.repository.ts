import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import { OutboxEvent, outboxEvents } from '../db/schema/outbox-events';
import { LeaseToken } from '../db/schema/background-leases';
import { IBackgroundLeaseRepository } from './background-lease.repository';

export interface IOutboxEventRepository {
    findUnpublished(limit: number): Promise<OutboxEvent[]>;
    markPublished(outboxEventId: string, lease: LeaseToken): Promise<void>;
    recordPublishFailure(outboxEventId: string, errorMessage: string, lease: LeaseToken): Promise<void>;
}

@injectable()
export class OutboxEventRepository implements IOutboxEventRepository {
    constructor(
        @inject(TYPES.Database) private readonly db: CanonicalStore,
        @inject(TYPES.IBackgroundLeaseRepository) private readonly leases: IBackgroundLeaseRepository
    ) {}

    async findUnpublished(limit: number): Promise<OutboxEvent[]> {
        return this.db
            .collection<OutboxEvent>(outboxEvents)
            .find<OutboxEvent>({ publishedAt: null }, { projection: { _id: 0 } })
            .sort({ createdAt: 1, outboxEventId: 1 })
            .limit(limit)
            .toArray();
    }

    async markPublished(outboxEventId: string, lease: LeaseToken): Promise<void> {
        await this.leases.withLease(lease, async (session, publishedAt) => {
            await this.db
                .collection<OutboxEvent>(outboxEvents)
                .updateOne({ _id: outboxEventId }, { $set: { publishedAt, lastError: null } }, { session });
        });
    }

    async recordPublishFailure(outboxEventId: string, errorMessage: string, lease: LeaseToken): Promise<void> {
        await this.leases.withLease(lease, async (session) => {
            await this.db
                .collection<OutboxEvent>(outboxEvents)
                .updateOne(
                    { _id: outboxEventId },
                    { $inc: { publishAttempts: 1 }, $set: { lastError: errorMessage.slice(0, 1000) } },
                    { session }
                );
        });
    }
}
