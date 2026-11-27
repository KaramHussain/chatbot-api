// Run this script once to apply migrations: npx tsx src/db/migrate.ts
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { BOOKING_DDL } from '../booking/ddl.js';

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

// Launcher designs: existing bots stay on the classic round button until their owner opts in.
await client`ALTER TABLE bots ADD COLUMN IF NOT EXISTS launcher_style text DEFAULT 'classic' NOT NULL`;
await client`ALTER TABLE bots ADD COLUMN IF NOT EXISTS launcher_label text`;
await client`ALTER TABLE bots ADD COLUMN IF NOT EXISTS launcher_gradient text DEFAULT 'aurora' NOT NULL`;
console.log('Launcher columns ready.');

// Voice UI style: 'fullscreen' (hands-free takeover, default) or 'inline' (stays
// in the chat — small orb + animated input, replies land as normal messages).
await client`ALTER TABLE bots ADD COLUMN IF NOT EXISTS voice_ui_style text DEFAULT 'fullscreen' NOT NULL`;
console.log('Voice UI style column ready.');

// Per-plan model chain (admin-editable): primary model tried first, then fallback_1, then
// fallback_2 — e.g. Opus first, Mistral if Opus isn't entitled yet, Nova as a last resort.
await client`CREATE TABLE IF NOT EXISTS plan_model_config (
  plan_id text PRIMARY KEY,
  primary_model text NOT NULL,
  fallback_1 text,
  fallback_2 text,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
)`;
await client`
  INSERT INTO plan_model_config (plan_id, primary_model, fallback_1, fallback_2) VALUES
    ('starter', 'us.amazon.nova-2-lite-v1:0', NULL, NULL),
    ('growth', 'us.anthropic.claude-opus-4-5-20251101-v1:0', 'mistral.mistral-large-3-675b-instruct', 'us.amazon.nova-2-lite-v1:0'),
    ('enterprise', 'us.anthropic.claude-opus-4-5-20251101-v1:0', 'mistral.mistral-large-3-675b-instruct', 'us.amazon.nova-2-lite-v1:0')
  ON CONFLICT (plan_id) DO NOTHING
`;
// One-time: a tenant's ai_model used to be stamped with its plan's static default at creation /
// plan-change time, which would otherwise shadow the new dynamic plan config below for every
// existing tenant. Clear it only where it still exactly matches one of those old static defaults —
// a tenant an admin deliberately pointed at something else keeps that custom choice.
await client`CREATE TABLE IF NOT EXISTS plan_model_migrations (name text PRIMARY KEY)`;
// _v2: the original run of this (same name, no suffix) was immediately undone in the same migrate
// run by the old "Plan models" block below it, which has since been removed — re-running it now
// actually sticks.
const ranAiModelClear = await client`INSERT INTO plan_model_migrations (name) VALUES ('clear_inherited_ai_model_defaults_v2') ON CONFLICT DO NOTHING RETURNING name`;
if (ranAiModelClear.length) {
  await client`UPDATE tenants SET ai_model = NULL WHERE ai_model IN ('us.amazon.nova-2-lite-v1:0', 'mistral.mistral-large-3-675b-instruct')`;
}
console.log('Plan model config ready.');

// (Removed Nov 27 2026: the old "Plan models (Oct 31 2026)" block used to re-stamp every tenant's
// ai_model with a static per-plan default on every single migrate run — including whenever it was
// NULL, which is exactly the "follow the plan dynamically" state the block above now relies on. It
// was undoing the one-time clear above in the very same run. Superseded by plan_model_config.)

// Bookings feature (idempotent DDL)
for (const stmt of BOOKING_DDL) await client.unsafe(stmt);
console.log('Booking tables ready.');

// One-time: bots created with the old default ("offer when the visitor shows interest") move to "only when asked".
await client`CREATE TABLE IF NOT EXISTS booking_migrations (name text PRIMARY KEY)`;
const ranOfferMode = await client`INSERT INTO booking_migrations (name) VALUES ('offer_mode_request_default') ON CONFLICT DO NOTHING RETURNING name`;
if (ranOfferMode.length) await client`UPDATE booking_settings SET offer_mode = 'request' WHERE offer_mode = 'intent'`;

await client.end();
