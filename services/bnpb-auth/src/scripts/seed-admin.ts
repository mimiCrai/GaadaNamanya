import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { Pool } from 'pg';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

async function main(): Promise<void> {
    const databaseUrl = required('DATABASE_URL');
    const email = required('ADMIN_EMAIL').trim().toLowerCase();
    const password = required('ADMIN_PASSWORD');

    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('ADMIN_EMAIL must be a valid email address');
    if (password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters long');

    const pool = new Pool({ connectionString: databaseUrl });
    try {
        const existing = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rowCount) {
            await pool.query("UPDATE users SET role = 'admin', updated_at = NOW() WHERE id = $1", [existing.rows[0].id]);
            console.log(`Existing account promoted to admin: ${email}`);
            return;
        }

        await pool.query(
            "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')",
            [email, await hashPassword(password)]
        );
        console.log(`Admin account created: ${email}`);
    } finally {
        await pool.end();
    }
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} must be configured`);
    return value;
}

async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString('base64url');
    const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
    return `scrypt$${salt}$${derivedKey.toString('base64url')}`;
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Failed to seed admin');
    process.exitCode = 1;
});
