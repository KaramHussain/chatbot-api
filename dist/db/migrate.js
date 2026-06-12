// Run this script once to apply migrations: npx tsx src/db/migrate.ts
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import 'dotenv/config';
const client = postgres(process.env.DATABASE_URL, { max: 1 });
const db = drizzle(client);
console.log('Running migrations...');
await migrate(db, { migrationsFolder: './src/db/migrations' });
console.log('Migrations complete.');
// Create ivfflat index for vector search after schema migration
await client `
  CREATE INDEX IF NOT EXISTS bot_chunks_embedding_idx
  ON bot_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100)
`;
console.log('Vector index created.');
await client.end();
//# sourceMappingURL=migrate.js.map