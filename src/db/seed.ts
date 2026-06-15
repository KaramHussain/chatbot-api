/**
 * Creates the initial super-admin user.
 * Run once after migrations: npx tsx src/db/seed.ts
 *
 * Usage:
 *   ADMIN_EMAIL=you@cloudgeniee.com ADMIN_PASSWORD=YourPassword npx tsx src/db/seed.ts
 */
import { loadSecretsIfNeeded } from '../lib/secrets.js';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();
await loadSecretsIfNeeded();

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import bcrypt from 'bcryptjs';

const client = postgres(process.env.DATABASE_URL!, { max: 1 });
const db = drizzle(client);

const email = process.env.ADMIN_EMAIL ?? 'cloudgeniee@gmail.com';
const password = process.env.ADMIN_PASSWORD ?? 'Admin@123!';
const name = process.env.ADMIN_NAME ?? 'CloudGeniee Admin';

const passwordHash = await bcrypt.hash(password, 12);

// Check if already exists
const existing = await client`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
if (existing.length > 0) {
  console.log(`Super-admin ${email} already exists.`);
} else {
  await client`
    INSERT INTO users (email, password_hash, name, role)
    VALUES (${email}, ${passwordHash}, ${name}, 'super_admin')
  `;
  console.log(`✓ Super-admin created: ${email}`);
  console.log(`  Password: ${password}`);
  console.log('  ⚠️  Change this password immediately after first login!');
}

await client.end();
