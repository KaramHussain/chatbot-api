import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, bots, tenantThemes } from '../db/index.js';
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
  headerTextColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
});

/** theme id -> the bots (id, name) currently using it. A profile is shared by every bot that uses it. */
async function usedByMap(tenantId: string): Promise<Map<string, Array<{ id: string; name: string }>>> {
  const rows = await db.select({ id: bots.id, name: bots.name, themeId: bots.tenantThemeId }).from(bots).where(eq(bots.tenantId, tenantId));
  const map = new Map<string, Array<{ id: string; name: string }>>();
  for (const r of rows) if (r.themeId) (map.get(r.themeId) ?? map.set(r.themeId, []).get(r.themeId)!).push({ id: r.id, name: r.name });
  return map;
}

// GET /api/themes — list all themes for current tenant
router.get('/', async (c) => {
  const tenantId = c.get('tenantId');
  const themes = await db
    .select()
    .from(tenantThemes)
    .where(eq(tenantThemes.tenantId, tenantId));
  const usedBy = await usedByMap(tenantId);
  return c.json({ themes: themes.map((t) => ({ ...t, usedBy: usedBy.get(t.id) ?? [] })) });
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
  return c.json({ theme: { ...theme, usedBy: (await usedByMap(tenantId)).get(theme.id) ?? [] } });
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
