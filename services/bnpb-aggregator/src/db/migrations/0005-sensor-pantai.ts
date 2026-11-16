import type { Migration } from '../migration-runner';
import { SourceStream, SourceSyncStatus, sourceSyncStates } from '../schema/source-sync-states';

export const sensorPantai: Migration = {
    id: '0005-sensor-pantai',
    async up(database) {
        const name = 'sensor_rejected_messages';
        if (!(await database.listCollections({ name }, { nameOnly: true }).hasNext()))
            await database.createCollection(name);
        if ((await database.admin().command({ hello: 1 })).msg === 'isdbgrid') {
            const namespace = `${database.databaseName}.${name}`;
            if (
                !(await database.client
                    .db('config')
                    .collection<{ _id: string; dropped?: boolean }>('collections')
                    .findOne({ _id: namespace, dropped: { $ne: true } }))
            ) {
                await database.collection(name).createIndex({ _id: 'hashed' });
                await database
                    .admin()
                    .command({ shardCollection: namespace, key: { _id: 'hashed' }, numInitialChunks: 8 });
            }
        }
        await database.collection(name).createIndex({ receivedAt: -1, messageId: 1 });
        await database.collection<{ _id: string }>(sourceSyncStates).updateOne(
            { _id: SourceStream.SensorPantai },
            {
                $setOnInsert: {
                    sourceStream: SourceStream.SensorPantai,
                    status: SourceSyncStatus.Unavailable,
                    lastSuccessfulPollAt: null,
                    lastAttemptAt: null,
                    staleSince: null,
                    lastError: null,
                    consecutiveFailures: 0,
                    cursor: null,
                    stations: [],
                    stationsUpdatedAt: null,
                    generatedAt: null,
                    latestObservedAt: null,
                    sourceProgressAt: null,
                    retryAt: null,
                },
            },
            { upsert: true }
        );
    },
};
