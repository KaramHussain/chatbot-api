import { Hono } from 'hono';
import { db, botAvatarPresets } from '../../db/index.js';
import { eq, asc } from 'drizzle-orm';
import { putObject } from '../../lib/s3.js';
import type { HonoEnv } from '../../types/index.js';

const router = new Hono<HonoEnv>();

const API_PUBLIC_URL = process.env.API_PUBLIC_URL ?? 'http://localhost:3001';

const VALID_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

// GET /api/admin/bot-avatars — list all presets (also used by client wizard)
router.get('/', async (c) => {
  const presets = await db
    .select()
    .from(botAvatarPresets)
    .orderBy(asc(botAvatarPresets.displayOrder), asc(botAvatarPresets.createdAt));
  return c.json({ presets });
});

// POST /api/admin/bot-avatars — upload a new preset avatar
router.post('/', async (c) => {
  const contentType = c.req.header('content-type')?.split(';')[0].trim() ?? '';
  const ext = VALID_IMAGE_TYPES[contentType];
  if (!ext) return c.json({ error: 'Invalid image type. Use PNG, JPG, WEBP, or SVG.' }, 400);

  const buffer = Buffer.from(await c.req.arrayBuffer());
  if (buffer.length > 2 * 1024 * 1024) return c.json({ error: 'File too large (max 2 MB)' }, 413);

  const name = c.req.header('x-preset-name') ?? 'Avatar';
  const id = crypto.randomUUID();
  const s3Key = `system/avatars/${id}.${ext}`;
  await putObject(s3Key, buffer, contentType);

  const imageUrl = `${API_PUBLIC_URL}/api/logos/${s3Key}`;

  const [preset] = await db
    .insert(botAvatarPresets)
    .values({ id, name, imageUrl, isDefault: false, displayOrder: 0 })
    .returning();

  return c.json({ preset }, 201);
});

// PATCH /api/admin/bot-avatars/:id — update name or set as default
router.patch('/:id', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json<{ name?: string; isDefault?: boolean; displayOrder?: number }>();

  if (body.isDefault) {
    // Clear existing default first
    await db.update(botAvatarPresets).set({ isDefault: false });
  }

  const [updated] = await db
    .update(botAvatarPresets)
    .set({
      ...(body.name !== undefined && { name: body.name }),
      ...(body.isDefault !== undefined && { isDefault: body.isDefault }),
      ...(body.displayOrder !== undefined && { displayOrder: body.displayOrder }),
    })
    .where(eq(botAvatarPresets.id, id))
    .returning();

  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json({ preset: updated });
});

// DELETE /api/admin/bot-avatars/:id
router.delete('/:id', async (c) => {
  const { id } = c.req.param();
  const [deleted] = await db
    .delete(botAvatarPresets)
    .where(eq(botAvatarPresets.id, id))
    .returning({ id: botAvatarPresets.id });
  if (!deleted) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});

export default router;
