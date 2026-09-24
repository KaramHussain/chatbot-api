// Bootstrap: load .env, then dynamically import the app so all modules see the populated process.env.
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

await import('./app.js');
