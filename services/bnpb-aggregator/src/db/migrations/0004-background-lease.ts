import type { Migration } from '../migration-runner';
import { BackgroundLease, backgroundLeaseId, backgroundLeases } from '../schema/background-leases';

export const backgroundLease: Migration = {
    id: '0004-background-lease',
    async up(database) {
        // Keep the epoch history: this coordination collection must not have a TTL index.
        await database
            .collection<BackgroundLease & { _id: string }>(backgroundLeases)
            .updateOne(
                { _id: backgroundLeaseId },
                {
                    $setOnInsert: {
                        ownerId: null,
                        epoch: 0,
                        expiresAt: new Date(0),
                        checkedAt: new Date(0),
                        guardVersion: 0,
                    },
                },
                { upsert: true }
            );
    },
};
