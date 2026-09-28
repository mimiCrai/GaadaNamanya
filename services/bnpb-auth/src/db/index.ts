import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import env from '../util/env';
import * as schema from './schema';

const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.NODE_ENV === 'production' ? 100 : 10,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 10000,
});

export const db = drizzle(pool, { schema });

export { pool };
