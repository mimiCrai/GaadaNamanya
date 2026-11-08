import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import { OutboxEvent, outboxEvents } from '../db/schema/outbox-events';

export interface IOutboxEventRepository {
    findUnpublished(limit: number): Promise<OutboxEvent[]>;
    markPublished(outboxEventId: string, publishedAt: Date): Promise<void>;
    recordPublishFailure(outboxEventId: string, errorMessage: string): Promise<void>;
}

@injectable()
export class OutboxEventRepository implements IOutboxEventRepository {
    constructor(@inject(TYPES.Database) private readonly db: CanonicalStore) {}

    async findUnpublished(limit: number): Promise<OutboxEvent[]> {
        return this.db
            .collection<OutboxEvent>(outboxEvents)
            .find<OutboxEvent>({ publishedAt: null }, { projection: { _id: 0 } })
            .sort({ createdAt: 1, outboxEventId: 1 })
            .limit(limit)
            .toArray();
    }

    async markPublished(outboxEventId: string, publishedAt: Date): Promise<void> {
        await this.db
            .collection<OutboxEvent>(outboxEvents)
            .updateOne({ _id: outboxEventId }, { $set: { publishedAt, lastError: null } });
    }

    async recordPublishFailure(outboxEventId: string, errorMessage: string): Promise<void> {
        await this.db
            .collection<OutboxEvent>(outboxEvents)
            .updateOne(
                { _id: outboxEventId },
                { $inc: { publishAttempts: 1 }, $set: { lastError: errorMessage.slice(0, 1000) } }
            );
    }
}
