import { Hono } from 'hono';
import { getObjectStream } from '../lib/s3.js';

const router = new Hono();

// GET /api/logos/tenants/:tenantId/bots/:botId/logo.:ext
// GET /api/logos/tenants/:tenantId/bots/:botId/launcher.:ext
// Proxies logo images from S3 (bucket has Block Public Access enabled)
router.get('/*', async (c) => {
  // Extract the key from the path: /api/logos/{key}
  const url = new URL(c.req.url);
  const key = url.pathname.replace(/^\/api\/logos\//, '');

  // Allow logo, launcher, bot-avatar (per bot) and system avatar presets
  const allowed = /^(tenants\/[^/]+\/bots\/[^/]+\/(logo|launcher|bot-avatar)\.[a-z]+|system\/avatars\/[^/]+\.[a-z]+)$/;
  if (!allowed.test(key)) {
    return c.json({ error: 'Not found' }, 404);
  }

  try {
    const { body, contentType } = await getObjectStream(key);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch {
    return c.json({ error: 'Not found' }, 404);
  }
});

export default router;
