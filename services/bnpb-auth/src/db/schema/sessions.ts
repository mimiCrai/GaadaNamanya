import { index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users';

export const sessions = pgTable(
    'sessions',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        refreshTokenHash: varchar('refresh_token_hash', { length: 255 }).notNull(),
        createdAt: timestamp('created_at').defaultNow().notNull(),
        expiresAt: timestamp('expires_at').notNull(),
        revokedAt: timestamp('revoked_at'),
    },
    (table) => [index('sessions_user_id_idx').on(table.userId)]
);

// Type inference helpers
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
