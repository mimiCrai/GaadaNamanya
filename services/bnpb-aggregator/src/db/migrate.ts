import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { runMigrations } from './migration-runner';

async function main(): Promise<void> {
    const env = z
        .object({
            DATABASE_URL: z.string().regex(/^mongodb(?:\+srv)?:\/\//),
            DATABASE_NAME: z.string().min(1).default('canonical_store'),
        })
        .parse(process.env);
    const client = new MongoClient(env.DATABASE_URL, {
        serverSelectionTimeoutMS: 10_000,
        writeConcern: { w: 'majority', journal: true },
    });

    try {
        await client.connect();
        const applied = await runMigrations(client.db(env.DATABASE_NAME));
        console.log(JSON.stringify({ event: 'database.migrations.completed', database: env.DATABASE_NAME, applied }));
    } finally {
        await client.close();
    }
}

void main().catch((error: unknown) => {
    console.error(
        JSON.stringify({
            event: 'database.migrations.failed',
            message: error instanceof Error ? error.message : String(error),
        })
    );
    process.exitCode = 1;
});
