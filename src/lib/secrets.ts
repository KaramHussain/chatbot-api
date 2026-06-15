import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const SECRET_NAME = process.env.AWS_SECRET_NAME ?? 'cloudgeniee/api';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

export async function loadSecretsIfNeeded(): Promise<void> {
  // If DATABASE_URL is already set (.env present and loaded), skip SM entirely
  if (process.env.DATABASE_URL) return;

  try {
    const client = new SecretsManagerClient({ region: REGION });
    const res = await client.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));

    if (!res.SecretString) {
      console.warn('[secrets] SecretString was empty — running with environment as-is');
      return;
    }

    const secrets = JSON.parse(res.SecretString) as Record<string, string>;
    let loaded = 0;
    for (const [key, value] of Object.entries(secrets)) {
      if (!process.env[key]) {
        process.env[key] = String(value);
        loaded++;
      }
    }
    console.log(`[secrets] Loaded ${loaded} values from Secrets Manager (${SECRET_NAME})`);
  } catch (err) {
    console.error('[secrets] Failed to load from Secrets Manager — continuing with current env:', err);
  }
}
