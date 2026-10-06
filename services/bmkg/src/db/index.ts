import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import * as schema from './schema';

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDatabase(connectionString: string, nodeEnv: string): { db: Database; pool: Pool } {
    const pool = new Pool({
        connectionString,
        max: nodeEnv === 'production' ? 20 : 10,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 10000,
    });
    return { db: drizzle(pool, { schema }), pool };
}
