import type { Migration } from '../migration-runner';
import { orderingSequences } from '../schema/ordering-sequences';

// new collection, sharded on hashed _id like every canonical collection (D-04).
export const orderingSequencesMigration: Migration = {
    id: '0007-ordering-sequences',
    async up(database) {
        const existing = await database.listCollections({ name: orderingSequences }, { nameOnly: true }).toArray();
        if (existing.length === 0) await database.createCollection(orderingSequences);
        if ((await database.admin().command({ hello: 1 })).msg !== 'isdbgrid') return;
        await database.collection(orderingSequences).createIndex({ _id: 'hashed' });
        const namespace = `${database.databaseName}.${orderingSequences}`;
        const sharded = await database.client
            .db('config')
            .collection<{ _id: string; dropped?: boolean }>('collections')
            .findOne({ _id: namespace, dropped: { $ne: true } });
        if (!sharded) await database.admin().command({ shardCollection: namespace, key: { _id: 'hashed' } });
    },
};
