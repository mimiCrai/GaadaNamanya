export DEMO_PASSWORD='password'

docker compose exec -T \
  -e DEMO_PASSWORD="$DEMO_PASSWORD" \
  bnpb-auth node - <<'NODE'
const { randomBytes, scryptSync } = require('node:crypto');
const { Pool } = require('pg');

const password = process.env.DEMO_PASSWORD;
const users = [
  ['admin@example.test', 'admin'],
  ['public@example.test', 'public'],
  ['lapangan@example.test', 'lapangan'],
  ['internal@example.test', 'internal'],
];

function hashPassword(value) {
  const salt = randomBytes(16).toString('base64url');
  const hash = scryptSync(value, salt, 64).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}

async function main() {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    for (const [email, role] of users) {
      await db.query(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             role = EXCLUDED.role,
             updated_at = NOW()`,
        [email, hashPassword(password), role]
      );

      console.log(`Seeded ${email} as ${role}`);
    }
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE