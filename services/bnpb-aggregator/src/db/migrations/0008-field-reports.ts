import type { Migration } from '../migration-runner';
import { fieldReports } from '../schema/field-reports';

// field_reports: sharded on hashed _id (= report_id) like every canonical collection (D-04, D-39).
export const fieldReportsMigration: Migration = {
    id: '0008-field-reports',
    async up(database) {
        const existing = await database.listCollections({ name: fieldReports }, { nameOnly: true }).toArray();
        if (existing.length === 0) await database.createCollection(fieldReports);
        await database.collection(fieldReports).createIndex({ acceptedAt: 1, _id: 1 }, { name: 'by_accepted_at' });
        if ((await database.admin().command({ hello: 1 })).msg !== 'isdbgrid') return;
        await database.collection(fieldReports).createIndex({ _id: 'hashed' });
        const namespace = `${database.databaseName}.${fieldReports}`;
        const sharded = await database.client
            .db('config')
            .collection<{ _id: string; dropped?: boolean }>('collections')
            .findOne({ _id: namespace, dropped: { $ne: true } });
        if (!sharded) await database.admin().command({ shardCollection: namespace, key: { _id: 'hashed' } });
    },
};
