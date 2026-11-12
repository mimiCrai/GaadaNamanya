import type { Migration } from '../migration-runner';

export const createCollectionsAndIndexes: Migration = {
    id: '0001-create-collections-and-indexes',
    async up(database) {
        const names = ['hazard_events', 'outbox_events', 'pending_tsunami_warnings', 'source_sync_states'];
        const existing = await database.listCollections({}, { nameOnly: true }).toArray();
        const sharded = (await database.admin().command({ hello: 1 })).msg === 'isdbgrid';

        for (const name of names) {
            if (!existing.some((collection) => collection.name === name)) {
                await database.createCollection(name);
            }
            if (sharded) {
                const namespace = `${database.databaseName}.${name}`;
                const metadata = await database.client
                    .db('config')
                    .collection<{ _id: string; dropped?: boolean }>('collections')
                    .findOne({
                        _id: namespace,
                        dropped: { $ne: true },
                    });
                if (!metadata) {
                    const empty = (await database.collection(name).countDocuments({}, { limit: 1 })) === 0;
                    await database.collection(name).createIndex({ _id: 'hashed' });
                    await database.admin().command({
                        shardCollection: namespace,
                        key: { _id: 'hashed' },
                        ...(empty ? { numInitialChunks: 8 } : {}),
                    });
                }
            }
        }

        await database
            .collection('hazard_events')
            .createIndexes([
                { key: { source: 1, sourceRefId: 1 } },
                { key: { ingestedAt: 1, hazardId: 1 } },
                { key: { occurredAt: -1, hazardId: 1 } },
            ]);
        await database
            .collection('outbox_events')
            .createIndex(
                { createdAt: 1, outboxEventId: 1 },
                { name: 'unpublished_in_order', partialFilterExpression: { publishedAt: null } }
            );
        await database.collection('pending_tsunami_warnings').createIndex({ firstReceivedAt: 1 });
    },
};
