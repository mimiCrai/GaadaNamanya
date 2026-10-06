import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Logger } from 'pino';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { TYPES } from '../src/constants/types';
import { Database } from '../src/db';
import * as schema from '../src/db/schema';
import { createLogger } from '../src/libs/logger';
import { IEventRepository } from '../src/repositories/event.repository';

export const BMKG_KEY = 'bmkg_test01_0123456789abcdef0123456789abcdef';
export const ROTATED_BMKG_KEY = 'bmkg_test02_fedcba9876543210fedcba9876543210';
export const PVMBG_TOKEN = 'pvmbg.bnpb.4f9c2a7e1b3d5f60718293a4b5c6d7e8';
export const BNPB_JWT =
    'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkb3duc3RyZWFtLWNsaWVudCIsInNjb3BlIjoiaGF6YXJkOnJlYWQifQ.c2lnbmF0dXJl';

let testDb: Promise<{ client: PGlite; db: Database }> | undefined;

export function getTestDb(): Promise<{ client: PGlite; db: Database }> {
    testDb ??= (async () => {
        const client = new PGlite();
        const db = drizzle(client, { schema });
        await migrate(db, { migrationsFolder: path.join(__dirname, '../src/db/migrations') });
        return { client, db };
    })();
    return testDb;
}

export async function resetTestDb(): Promise<Database> {
    const { db } = await getTestDb();
    await db.execute(sql`truncate table tsunami_warnings, seismic_events`);
    return db;
}

export async function closeTestDb(): Promise<void> {
    if (!testDb) return;
    const { client } = await testDb;
    testDb = undefined;
    await client.close();
}

export async function buildApp(logger: Logger = createLogger({ level: 'silent' })) {
    const db = await resetTestDb();
    const bmkg = await createApp(loadConfig(), db, { logger });
    return { ...bmkg, db, events: bmkg.container.get<IEventRepository>(TYPES.IEventRepository) };
}
