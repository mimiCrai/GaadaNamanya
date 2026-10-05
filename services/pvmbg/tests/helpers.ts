import { AddressInfo } from 'net';
import path from 'path';
import { Writable } from 'stream';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Application } from 'express';
import { Logger } from 'pino';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { TYPES } from '../src/constants/types';
import { Database } from '../src/db';
import * as schema from '../src/db/schema';
import { createLogger } from '../src/libs/logger';
import { IReportRepository } from '../src/repositories/report.repository';

export const PVMBG_TOKEN = 'pvmbg.bnpb.4f9c2a7e1b3d5f60718293a4b5c6d7e8';
export const ROTATED_PVMBG_TOKEN = 'pvmbg.bnpb-2.0123456789abcdef0123456789abcdef';
export const BMKG_KEY = 'bmkg_test01_0123456789abcdef0123456789abcdef';
export const BNPB_JWT =
    'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkb3duc3RyZWFtLWNsaWVudCIsInNjb3BlIjoiaGF6YXJkOnJlYWQifQ.c2lnbmF0dXJl';

export interface BuildOptions {
    logger?: Logger;
    env?: Record<string, string>;
}

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
    await db.execute(sql`truncate table volcanic_reports`);
    return db;
}

export async function closeTestDb(): Promise<void> {
    if (!testDb) return;
    const { client } = await testDb;
    testDb = undefined;
    await client.close();
}

export async function buildApp({ logger = createLogger({ level: 'silent' }), env = {} }: BuildOptions = {}) {
    const db = await resetTestDb();
    const pvmbg = await createApp(loadConfig({ ...process.env, ...env }), db, { logger });
    return { ...pvmbg, db, reports: pvmbg.container.get<IReportRepository>(TYPES.IReportRepository) };
}

export function captureLogs() {
    const lines: string[] = [];
    const stream = new Writable({
        write(chunk, _encoding, callback) {
            lines.push(chunk.toString());
            callback();
        },
    });
    return {
        logger: createLogger({ level: 'info', stream }),
        raw: () => lines.join(''),
        entries: (): Record<string, unknown>[] => lines.map((line) => JSON.parse(line)),
    };
}

export async function listen(app: Application) {
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
