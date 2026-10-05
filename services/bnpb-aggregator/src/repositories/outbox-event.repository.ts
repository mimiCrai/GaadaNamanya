import { asc, eq, isNull, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import * as schema from '../db/schema';
import { OutboxEvent, outboxEvents } from '../db/schema/outbox-events';

export interface IOutboxEventRepository {
    findUnpublished(limit: number): Promise<OutboxEvent[]>;
    markPublished(outboxEventId: string, publishedAt: Date): Promise<void>;
    recordPublishFailure(outboxEventId: string, errorMessage: string): Promise<void>;
}

@injectable()
export class OutboxEventRepository implements IOutboxEventRepository {
    constructor(@inject(TYPES.Database) private readonly db: NodePgDatabase<typeof schema>) {}

    async findUnpublished(limit: number): Promise<OutboxEvent[]> {
        return this.db
            .select()
            .from(outboxEvents)
            .where(isNull(outboxEvents.publishedAt))
            .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.outboxEventId))
            .limit(limit);
    }

    async markPublished(outboxEventId: string, publishedAt: Date): Promise<void> {
        await this.db
            .update(outboxEvents)
            .set({ publishedAt, lastError: null })
            .where(eq(outboxEvents.outboxEventId, outboxEventId));
    }

    async recordPublishFailure(outboxEventId: string, errorMessage: string): Promise<void> {
        await this.db
            .update(outboxEvents)
            .set({
                publishAttempts: sql`${outboxEvents.publishAttempts} + 1`,
                lastError: errorMessage.slice(0, 1000),
            })
            .where(eq(outboxEvents.outboxEventId, outboxEventId));
    }
}
