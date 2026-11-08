import type { Migration } from '../migration-runner';

export const seedSourceSyncStates: Migration = {
    id: '0002-seed-source-sync-states',
    async up(database) {
        for (const sourceStream of ['BMKG_SEISMIC', 'BMKG_TSUNAMI_WARNING', 'PVMBG_VOLCANIC']) {
            await database.collection<{ _id: string }>('source_sync_states').updateOne(
                { _id: sourceStream },
                {
                    $setOnInsert: {
                        sourceStream,
                        status: 'UNAVAILABLE',
                        lastSuccessfulPollAt: null,
                        lastAttemptAt: null,
                        staleSince: null,
                        lastError: null,
                        consecutiveFailures: 0,
                    },
                },
                { upsert: true }
            );
        }
    },
};
