import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, bots } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { getPresignedUploadUrl, buildLogoKey } from '../lib/s3.js';
const router = new Hono();
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
    if (!bot)
        return c.json({ error: 'Not found' }, 404);
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
});
router.post('/', zValidator('json', createBotSchema), async (c) => {
    const tenantId = c.get('tenantId');
    const body = c.req.valid('json');
    const [existing] = await db
        .select({ id: bots.id })
        .from(bots)
        .where(and(eq(bots.tenantId, tenantId), eq(bots.slug, body.slug)))
        .limit(1);
    if (existing)
        return c.json({ error: 'Slug already taken' }, 409);
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
    if (!updated)
        return c.json({ error: 'Not found' }, 404);
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
    if (!deleted)
        return c.json({ error: 'Not found' }, 404);
    return c.json({ success: true });
});
// POST /api/bots/:id/logo-upload-url — get presigned S3 URL to upload logo
const logoUploadSchema = z.object({
    contentType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
    fileExtension: z.enum(['png', 'jpg', 'jpeg', 'webp', 'svg']),
});
router.post('/:id/logo-upload-url', zValidator('json', logoUploadSchema), async (c) => {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { contentType, fileExtension } = c.req.valid('json');
    const [bot] = await db
        .select({ id: bots.id })
        .from(bots)
        .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId)))
        .limit(1);
    if (!bot)
        return c.json({ error: 'Not found' }, 404);
    const s3Key = buildLogoKey(tenantId, id, fileExtension);
    const uploadUrl = await getPresignedUploadUrl({ key: s3Key, contentType });
    const publicUrl = `https://${process.env.S3_BUCKET_NAME}.s3.amazonaws.com/${s3Key}`;
    await db
        .update(bots)
        .set({ logoUrl: publicUrl, updatedAt: new Date() })
        .where(eq(bots.id, id));
    return c.json({ uploadUrl, logoUrl: publicUrl });
});
// POST /api/bots/:id/launcher-logo-upload-url — presigned URL for launcher button image
router.post('/:id/launcher-logo-upload-url', zValidator('json', logoUploadSchema), async (c) => {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const { contentType, fileExtension } = c.req.valid('json');
    const [bot] = await db
        .select({ id: bots.id })
        .from(bots)
        .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId)))
        .limit(1);
    if (!bot)
        return c.json({ error: 'Not found' }, 404);
    const s3Key = `tenants/${tenantId}/bots/${id}/launcher.${fileExtension}`;
    const uploadUrl = await getPresignedUploadUrl({ key: s3Key, contentType });
    const publicUrl = `https://${process.env.S3_BUCKET_NAME}.s3.amazonaws.com/${s3Key}`;
    await db
        .update(bots)
        .set({ launcherLogoUrl: publicUrl, updatedAt: new Date() })
        .where(eq(bots.id, id));
    return c.json({ uploadUrl, launcherLogoUrl: publicUrl });
});
export default router;
//# sourceMappingURL=bots.js.map