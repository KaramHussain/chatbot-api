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

await client.end();
