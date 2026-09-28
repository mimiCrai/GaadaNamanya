import { pgTable, pgEnum, uuid, varchar, timestamp, text } from 'drizzle-orm/pg-core';

// Postgres enum
export const itemStatusEnum = pgEnum('item_status', ['draft', 'published', 'archived']);

export const items = pgTable('items', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    status: itemStatusEnum('status').notNull().default('draft'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Type inference helpers
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type ItemStatus = (typeof itemStatusEnum.enumValues)[number];
