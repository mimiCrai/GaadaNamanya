import type { Db, Document } from 'mongodb';
import type { Migration } from '../migration-runner';
import { unprocessedMessages, unprocessedPayloadBucket } from '../schema/unprocessed-messages';

async function isSharded(database: Db, name: string): Promise<boolean> {
    const metadata = await database.client
        .db('config')
        .collection<{ _id: string; dropped?: boolean }>('collections')
        .findOne({ _id: `${database.databaseName}.${name}`, dropped: { $ne: true } });
    return Boolean(metadata);
}

async function ensureCollection(database: Db, name: string): Promise<void> {
    const existing = await database.listCollections({ name }, { nameOnly: true }).toArray();
    if (existing.length === 0) await database.createCollection(name);
}

async function shard(database: Db, name: string, key: Document, extra: Document = {}): Promise<void> {
    if (await isSharded(database, name)) return;
    await database.admin().command({ shardCollection: `${database.databaseName}.${name}`, key, ...extra });
}

export const unprocessedMessagesMigration: Migration = {
    id: '0005-unprocessed-messages',
    async up(database) {
        const sharded = (await database.admin().command({ hello: 1 })).msg === 'isdbgrid';

        await ensureCollection(database, unprocessedMessages);
        if (sharded) {
            await database.collection(unprocessedMessages).createIndex({ _id: 'hashed' });
            const empty = (await database.collection(unprocessedMessages).countDocuments({}, { limit: 1 })) === 0;
            await shard(database, unprocessedMessages, { _id: 'hashed' }, empty ? { numInitialChunks: 8 } : {});
        }
        await database.collection(unprocessedMessages).createIndexes([
            { key: { status: 1, receivedAt: 1, _id: 1 }, name: 'audit_by_status' },
            { key: { source: 1, status: 1, receivedAt: 1, _id: 1 }, name: 'audit_by_source_status' },
            { key: { status: 1, nextAttemptAt: 1 }, name: 'retry_due' },
            { key: { source: 1, sourceRefId: 1, receivedAt: 1 }, name: 'replay_by_source_ref' },
        ]);

        const files = `${unprocessedPayloadBucket}.files`;
        const chunks = `${unprocessedPayloadBucket}.chunks`;
        await ensureCollection(database, files);
        await ensureCollection(database, chunks);
        await database.collection(files).createIndex({ filename: 1, uploadDate: 1 });
        await database.collection(chunks).createIndex({ files_id: 1, n: 1 }, { unique: true });
        if (sharded) await shard(database, chunks, { files_id: 1, n: 1 });
    },
};
