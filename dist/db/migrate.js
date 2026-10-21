// Run this script once to apply migrations: npx tsx src/db/migrate.ts
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
const client = postgres(process.env.DATABASE_URL, { max: 1 });
const db = drizzle(client);
console.log('Running migrations...');
await migrate(db, { migrationsFolder: './src/db/migrations' });
console.log('Migrations complete.');
// Switch vector index from ivfflat to HNSW (faster + more accurate search)
await client `DROP INDEX IF EXISTS bot_chunks_embedding_idx`;
await client `
  CREATE INDEX IF NOT EXISTS bot_chunks_embedding_idx
  ON bot_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
`;
console.log('HNSW vector index created.');
// Support Google sign-in: password is optional, and we track the linked Google account
await client `ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`;
await client `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id text`;
console.log('Google auth columns ready.');
// Pricing tiers: booking placeholder toggle
await client `ALTER TABLE bots ADD COLUMN IF NOT EXISTS booking_enabled boolean DEFAULT false NOT NULL`;
console.log('Booking column ready.');
// Draft bots: unfinished creations are saved as drafts
await client `ALTER TYPE bot_status ADD VALUE IF NOT EXISTS 'draft'`;
console.log('Draft bot status ready.');
// Voice feature: per-bot text-to-speech (only text is stored, never audio)
await client `ALTER TABLE bots ADD COLUMN IF NOT EXISTS voice_enabled boolean DEFAULT false NOT NULL`;
await client `ALTER TABLE bots ADD COLUMN IF NOT EXISTS voice_id text DEFAULT 'Joanna' NOT NULL`;
await client `ALTER TABLE bots ADD COLUMN IF NOT EXISTS voice_intro text`;
// Voice provider = Deepgram Aura-2 — migrate old Polly + Aura-v1 ids.
await client `ALTER TABLE bots ALTER COLUMN voice_id SET DEFAULT 'aura-2-thalia-en'`;
await client `UPDATE bots SET voice_id = 'aura-2-thalia-en' WHERE voice_id IS NULL OR voice_id NOT LIKE 'aura-2-%'`;
console.log('Voice columns ready.');
await client.end();
//# sourceMappingURL=migrate.js.map