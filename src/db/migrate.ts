// Run this script once to apply migrations: npx tsx src/db/migrate.ts
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const client = postgres(process.env.DATABASE_URL!, { max: 1 });
const db = drizzle(client);

console.log('Running migrations...');
await migrate(db, { migrationsFolder: './src/db/migrations' });
console.log('Migrations complete.');

// Switch vector index from ivfflat to HNSW (faster + more accurate search)
await client`DROP INDEX IF EXISTS bot_chunks_embedding_idx`;
await client`
  CREATE INDEX IF NOT EXISTS bot_chunks_embedding_idx
  ON bot_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
`;
console.log('HNSW vector index created.');

// Support Google sign-in: password is optional, and we track the linked Google account
await client`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`;
await client`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id text`;
console.log('Google auth columns ready.');

// Pricing tiers: booking placeholder toggle
await client`ALTER TABLE bots ADD COLUMN IF NOT EXISTS booking_enabled boolean DEFAULT false NOT NULL`;
console.log('Booking column ready.');

// Draft bots: unfinished creations are saved as drafts
await client`ALTER TYPE bot_status ADD VALUE IF NOT EXISTS 'draft'`;
console.log('Draft bot status ready.');

// Voice feature: per-bot text-to-speech (only text is stored, never audio)
await client`ALTER TABLE bots ADD COLUMN IF NOT EXISTS voice_enabled boolean DEFAULT false NOT NULL`;
await client`ALTER TABLE bots ADD COLUMN IF NOT EXISTS voice_id text DEFAULT 'Joanna' NOT NULL`;
await client`ALTER TABLE bots ADD COLUMN IF NOT EXISTS voice_intro text`;
// Voice provider = Deepgram Aura-2 — migrate old Polly + Aura-v1 ids.
await client`ALTER TABLE bots ALTER COLUMN voice_id SET DEFAULT 'aura-2-thalia-en'`;
await client`UPDATE bots SET voice_id = 'aura-2-thalia-en' WHERE voice_id IS NULL OR voice_id NOT LIKE 'aura-2-%'`;
console.log('Voice columns ready.');

// Plan models (Oct 31 2026): Free = Nova 2 Lite, Growth/Business = Mistral Large 3.
// Tenants still on a previous plan default move to their plan's model; custom admin picks are kept.
await client`ALTER TABLE tenants ALTER COLUMN ai_model SET DEFAULT 'us.amazon.nova-2-lite-v1:0'`;
await client`
  UPDATE tenants SET ai_model = CASE plan
    WHEN 'starter' THEN 'us.amazon.nova-2-lite-v1:0'
    WHEN 'growth' THEN 'mistral.mistral-large-3-675b-instruct'
    WHEN 'enterprise' THEN 'mistral.mistral-large-3-675b-instruct'
  END
  WHERE ai_model IS NULL OR ai_model IN (
    'amazon.nova-lite-v1:0', 'amazon.nova-pro-v1:0',
    'mistral.mistral-large-3-675b-instruct', 'us.anthropic.claude-opus-4-5-20251101-v1:0'
  )`;
await client`UPDATE bots SET llm_model = NULL WHERE llm_model = 'us.anthropic.claude-opus-4-5-20251101-v1:0'`;
// Claude removed (Oct 31 2026 — Bedrock Marketplace billing blocked): Business → Mistral Large 3.
await client`UPDATE tenants SET ai_model = 'mistral.mistral-large-3-675b-instruct' WHERE ai_model = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'`;
await client`UPDATE bots SET llm_model = NULL WHERE llm_model LIKE '%anthropic.claude%'`;
console.log('Plan models ready.');

await client.end();
