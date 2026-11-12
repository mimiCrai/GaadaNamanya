import type { Migration } from '../migration-runner';

export const auditReadIndexes: Migration = {
    id: '0003-audit-read-indexes',
    async up(database) {
        await database
            .collection('hazard_events')
            .createIndexes([
                { key: { source: 1, ingestedAt: 1, hazardId: 1 } },
                { key: { sourceRefId: 1, hazardId: 1 } },
                { key: { source: 1, sourceRefId: 1, hazardId: 1 } },
                { key: { source: 1, occurredAt: -1, hazardId: 1 } },
            ]);
    },
};
