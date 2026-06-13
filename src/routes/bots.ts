import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, bots } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { putObject, buildLogoKey } from '../lib/s3.js';
import type { HonoEnv } from '../types/index.js';

const router = new Hono<HonoEnv>();

// GET /api/bots — list bots for current tenant
router.get('/', async (c) => {
  const tenantId = c.get('tenantId');
  const rows = await db.select().from(bots).where(eq(bots.tenantId, tenantId));
  return c.json({ bots: rows });
});

// GET /api/bots/:id
router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();

  const [bot] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId)))
    .limit(1);

  if (!bot) return c.json({ error: 'Not found' }, 404);
  return c.json({ bot });
});

// POST /api/bots — create a new bot
const createBotSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/),
  welcomeMessage: z.string().max(500).optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  systemPrompt: z.string().max(2000).optional(),
  allowedOrigins: z.array(z.string().url()).default([]),
  leadCaptureEnabled: z.boolean().default(false),
  leadCaptureMessage: z.string().max(300).optional(),
  themeName: z.string().max(50).optional(),
  userBubbleColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  botBubbleBg: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  launcherSize: z.number().int().min(1).max(6).optional(),
  widgetPosition: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']).optional(),
  launcherTransparent: z.boolean().optional(),
  botAvatarUrl: z.string().url().nullable().optional(),
  responseStyle: z.enum(['balanced', 'concise', 'very_concise', 'detailed', 'bullet_points', 'professional', 'friendly']).optional(),
  displayName: z.string().max(100).nullable().optional(),
});

router.post('/', zValidator('json', createBotSchema), async (c) => {
  const tenantId = c.get('tenantId');
  const body = c.req.valid('json');

  const [existing] = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.tenantId, tenantId), eq(bots.slug, body.slug)))
    .limit(1);

  if (existing) return c.json({ error: 'Slug already taken' }, 409);

  const [bot] = await db
    .insert(bots)
    .values({ ...body, tenantId })
    .returning();

  return c.json({ bot }, 201);
});

// PUT /api/bots/:id — update bot settings / branding
const updateBotSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  displayName: z.string().max(100).nullable().optional(),
  welcomeMessage: z.string().max(500).optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  systemPrompt: z.string().max(2000).nullable().optional(),
  allowedOrigins: z.array(z.string()).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  leadCaptureEnabled: z.boolean().optional(),
  leadCaptureMessage: z.string().max(300).optional(),
  llmModel: z.string().optional(),
  responseStyle: z.enum(['balanced', 'concise', 'very_concise', 'detailed', 'bullet_points', 'professional', 'friendly']).optional(),
  themeName: z.string().max(50).optional(),
  userBubbleColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  botBubbleBg: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  launcherSize: z.number().int().min(1).max(6).optional(),
  widgetPosition: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']).optional(),
  launcherTransparent: z.boolean().optional(),
  botAvatarUrl: z.string().url().nullable().optional(),
});

router.put('/:id', zValidator('json', updateBotSchema), async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();
  const body = c.req.valid('json');

  const [updated] = await db
    .update(bots)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId)))
    .returning();

  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json({ bot: updated });
});

// DELETE /api/bots/:id
router.delete('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();

  const [deleted] = await db
    .delete(bots)
    .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId)))
    .returning({ id: bots.id });

  if (!deleted) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});

const VALID_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

const API_PUBLIC_URL = process.env.API_PUBLIC_URL ?? 'http://localhost:3001';

// POST /api/bots/:id/logo — upload chat header logo directly
router.post('/:id/logo', async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();
  const contentType = c.req.header('content-type')?.split(';')[0].trim() ?? '';
  const ext = VALID_IMAGE_TYPES[contentType];
  if (!ext) return c.json({ error: 'Invalid image type. Use PNG, JPG, WEBP, or SVG.' }, 400);

  const [bot] = await db.select({ id: bots.id }).from(bots)
    .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
  if (!bot) return c.json({ error: 'Not found' }, 404);

  const buffer = Buffer.from(await c.req.arrayBuffer());
  if (buffer.length > 2 * 1024 * 1024) return c.json({ error: 'File too large (max 2 MB)' }, 413);

  const s3Key = buildLogoKey(tenantId, id, ext);
  await putObject(s3Key, buffer, contentType);

  const logoUrl = `${API_PUBLIC_URL}/api/logos/${s3Key}`;
  await db.update(bots).set({ logoUrl, updatedAt: new Date() }).where(eq(bots.id, id));

  return c.json({ logoUrl });
});

// POST /api/bots/:id/bot-avatar — upload the small avatar shown beside each AI message
router.post('/:id/bot-avatar', async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();
  const contentType = c.req.header('content-type')?.split(';')[0].trim() ?? '';
  const ext = VALID_IMAGE_TYPES[contentType];
  if (!ext) return c.json({ error: 'Invalid image type. Use PNG, JPG, WEBP, or SVG.' }, 400);

  const [bot] = await db.select({ id: bots.id }).from(bots)
    .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
  if (!bot) return c.json({ error: 'Not found' }, 404);

  const buffer = Buffer.from(await c.req.arrayBuffer());
  if (buffer.length > 2 * 1024 * 1024) return c.json({ error: 'File too large (max 2 MB)' }, 413);

  const s3Key = `tenants/${tenantId}/bots/${id}/bot-avatar.${ext}`;
  await putObject(s3Key, buffer, contentType);

  const botAvatarUrl = `${API_PUBLIC_URL}/api/logos/${s3Key}`;
  await db.update(bots).set({ botAvatarUrl, updatedAt: new Date() }).where(eq(bots.id, id));

  return c.json({ botAvatarUrl });
});

// POST /api/bots/:id/launcher-logo — upload launcher button logo directly
router.post('/:id/launcher-logo', async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();
  const contentType = c.req.header('content-type')?.split(';')[0].trim() ?? '';
  const ext = VALID_IMAGE_TYPES[contentType];
  if (!ext) return c.json({ error: 'Invalid image type. Use PNG, JPG, WEBP, or SVG.' }, 400);

  const [bot] = await db.select({ id: bots.id }).from(bots)
    .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
  if (!bot) return c.json({ error: 'Not found' }, 404);

  const buffer = Buffer.from(await c.req.arrayBuffer());
  if (buffer.length > 2 * 1024 * 1024) return c.json({ error: 'File too large (max 2 MB)' }, 413);

  const s3Key = `tenants/${tenantId}/bots/${id}/launcher.${ext}`;
  await putObject(s3Key, buffer, contentType);

  const launcherLogoUrl = `${API_PUBLIC_URL}/api/logos/${s3Key}`;
  await db.update(bots).set({ launcherLogoUrl, updatedAt: new Date() }).where(eq(bots.id, id));

  return c.json({ launcherLogoUrl });
});

export default router;
