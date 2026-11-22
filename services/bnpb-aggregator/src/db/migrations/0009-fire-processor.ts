import type { Db, Document } from 'mongodb';
import type { Migration } from '../migration-runner';
import { fireProcessorState, fireSnapshotBucket, hazardTombstones, lateDetections } from '../schema/fire-processor';

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

async function shard(database: Db, name: string, key: Document): Promise<void> {
    if (await isSharded(database, name)) return;
    await database.admin().command({ shardCollection: `${database.databaseName}.${name}`, key });
}

// hazard_tombstones, late_detections, fire_processor_state, GridFS fire_snapshots; hashed _id like 0006/0008
export const fireProcessorMigration: Migration = {
    id: '0009-fire-processor',
    async up(database) {
        const sharded = (await database.admin().command({ hello: 1 })).msg === 'isdbgrid';
        for (const name of [hazardTombstones, lateDetections, fireProcessorState]) {
            await ensureCollection(database, name);
            if (sharded) {
                await database.collection(name).createIndex({ _id: 'hashed' });
                await shard(database, name, { _id: 'hashed' });
            }
        }
        await database.collection(lateDetections).createIndex({ offset: 1 }, { name: 'by_offset' });

        const files = `${fireSnapshotBucket}.files`;
        const chunks = `${fireSnapshotBucket}.chunks`;
        await ensureCollection(database, files);
        await ensureCollection(database, chunks);
        await database.collection(files).createIndex({ filename: 1, uploadDate: 1 });
        await database.collection(chunks).createIndex({ files_id: 1, n: 1 }, { unique: true });
        if (sharded) await shard(database, chunks, { files_id: 1, n: 1 });
    },
};
