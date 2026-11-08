import { Db } from 'mongodb';
import { createCollectionsAndIndexes } from './migrations/0001-create-collections-and-indexes';
import { seedSourceSyncStates } from './migrations/0002-seed-source-sync-states';

export interface Migration {
    id: string;
    up(database: Db): Promise<void>;
}

export const migrations: Migration[] = [createCollectionsAndIndexes, seedSourceSyncStates];

export async function runMigrations(database: Db, pending: Migration[] = migrations): Promise<string[]> {
    const history = database.collection<{ _id: string; appliedAt: Date }>('schema_migrations');
    const applied: string[] = [];

    for (const migration of pending) {
        if (await history.findOne({ _id: migration.id })) continue;

        await migration.up(database);
        await history.insertOne({ _id: migration.id, appliedAt: new Date() });
        applied.push(migration.id);
    }

    return applied;
}
