import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
}
// postgres-js client — disable prefetch for serverless/lambda, keep it for long-running servers
const client = postgres(process.env.DATABASE_URL, {
    max: 10, // connection pool size
    idle_timeout: 30,
    connect_timeout: 10,
});
export const db = drizzle(client, { schema });
// Re-export schema for convenience
export * from './schema.js';
//# sourceMappingURL=index.js.map