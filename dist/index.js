// Bootstrap: load secrets from AWS Secrets Manager if no .env is present,
// then dynamically import the app so all modules see the populated process.env.
import { loadSecretsIfNeeded } from './lib/secrets.js';
import { config as dotenvConfig } from 'dotenv';
// 1. Try .env first (sets DATABASE_URL etc. if the file exists)
dotenvConfig();
// 2. If DATABASE_URL still not set, pull everything from Secrets Manager
await loadSecretsIfNeeded();
// 3. Import the app — all module-level process.env reads happen after this point
await import('./app.js');
//# sourceMappingURL=index.js.map