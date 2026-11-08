import { Collection, Db, Document, MongoClient } from 'mongodb';
import env from '../util/env';

export class CanonicalStore {
    readonly client: MongoClient;
    readonly database: Db;

    constructor(uri: string, databaseName: string) {
        this.client = new MongoClient(uri, {
            maxPoolSize: env.NODE_ENV === 'production' ? 100 : 10,
            serverSelectionTimeoutMS: 10_000,
            connectTimeoutMS: 10_000,
            writeConcern: { w: 'majority', journal: true },
        });
        this.database = this.client.db(databaseName);
    }

    collection<T extends Document>(name: string): Collection<T & { _id: string }> {
        return this.database.collection<T & { _id: string }>(name);
    }

    async connect(): Promise<void> {
        await this.client.connect();
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}

export const db = new CanonicalStore(env.DATABASE_URL, env.DATABASE_NAME);
