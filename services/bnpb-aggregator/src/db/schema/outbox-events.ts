import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

export enum HazardEventChangeType {
    Created = 'hazard.created',
    Updated = 'hazard.updated',
}

export const outboxEvents = pgTable(
    'outbox_events',
    {
        outboxEventId: varchar('outbox_event_id', { length: 36 }).primaryKey(),
        aggregateId: varchar('aggregate_id', { length: 128 }).notNull(),
        eventType: varchar('event_type', { length: 64 }).$type<HazardEventChangeType>().notNull(),
        topic: varchar('topic', { length: 255 }).notNull(),
        partitionKey: varchar('partition_key', { length: 255 }).notNull(),
        payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        publishedAt: timestamp('published_at', { withTimezone: true }),
        publishAttempts: integer('publish_attempts').notNull().default(0),
        lastError: varchar('last_error', { length: 1000 }),
    },
    (table) => [
        index('outbox_events_unpublished_created_at_index')
            .on(table.createdAt)
            .where(sql`${table.publishedAt} IS NULL`),
    ]
);

export type OutboxEvent = typeof outboxEvents.$inferSelect;
