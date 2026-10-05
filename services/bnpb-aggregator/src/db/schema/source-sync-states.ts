import { integer, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export enum SourceStream {
    BmkgSeismic = 'BMKG_SEISMIC',
    BmkgTsunamiWarning = 'BMKG_TSUNAMI_WARNING',
    PvmbgVolcanic = 'PVMBG_VOLCANIC',
}

export enum SourceSyncStatus {
    Healthy = 'HEALTHY',
    Stale = 'STALE',
    Unavailable = 'UNAVAILABLE',
}

export const sourceStreamEnum = pgEnum('source_stream', [
    SourceStream.BmkgSeismic,
    SourceStream.BmkgTsunamiWarning,
    SourceStream.PvmbgVolcanic,
]);

export const sourceSyncStatusEnum = pgEnum('source_sync_status', [
    SourceSyncStatus.Healthy,
    SourceSyncStatus.Stale,
    SourceSyncStatus.Unavailable,
]);

export const sourceSyncStates = pgTable('source_sync_states', {
    sourceStream: sourceStreamEnum('source_stream').primaryKey(),
    status: sourceSyncStatusEnum('status').notNull().default(SourceSyncStatus.Unavailable),
    lastSuccessfulPollAt: timestamp('last_successful_poll_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    staleSince: timestamp('stale_since', { withTimezone: true }),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
});

export type SourceSyncState = typeof sourceSyncStates.$inferSelect;
