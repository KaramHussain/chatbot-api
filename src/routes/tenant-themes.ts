import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, tenantThemes } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import type { HonoEnv } from '../types/index.js';

const router = new Hono<HonoEnv>();

const themeSchema = z.object({
  name: z.string().min(1).max(80),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  userBubbleColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  botBubbleBg: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  botTextColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  windowBg: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  inputBg: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  userText: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#ffffff'),
  headerLogoBg: z.string().nullable().optional(),
});

// GET /api/themes — list all themes for current tenant
router.get('/', async (c) => {
  const tenantId = c.get('tenantId');
  const themes = await db
    .select()
    .from(tenantThemes)
    .where(eq(tenantThemes.tenantId, tenantId));
  return c.json({ themes });
});

// GET /api/themes/:id
router.get('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();
  const [theme] = await db
    .select()
    .from(tenantThemes)
    .where(and(eq(tenantThemes.id, id), eq(tenantThemes.tenantId, tenantId)))
    .limit(1);
  if (!theme) return c.json({ error: 'Not found' }, 404);
  return c.json({ theme });
});

// POST /api/themes — create custom theme
router.post('/', zValidator('json', themeSchema), async (c) => {
  const tenantId = c.get('tenantId');
  const body = c.req.valid('json');
  const [theme] = await db
    .insert(tenantThemes)
    .values({ ...body, tenantId })
    .returning();
  return c.json({ theme }, 201);
});

// PUT /api/themes/:id
router.put('/:id', zValidator('json', themeSchema.partial()), async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();
  const body = c.req.valid('json');
  const [updated] = await db
    .update(tenantThemes)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(tenantThemes.id, id), eq(tenantThemes.tenantId, tenantId)))
    .returning();
  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json({ theme: updated });
});

// DELETE /api/themes/:id
router.delete('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();
  const [deleted] = await db
    .delete(tenantThemes)
    .where(and(eq(tenantThemes.id, id), eq(tenantThemes.tenantId, tenantId)))
    .returning({ id: tenantThemes.id });
  if (!deleted) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});

export default router;
