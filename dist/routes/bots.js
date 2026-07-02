import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, bots, botChunks, conversations, messages } from '../db/index.js';
import { eq, and, count, desc, gte, lte, asc, sql } from 'drizzle-orm';
import { putObject, buildLogoKey } from '../lib/s3.js';
import sharp from 'sharp';
const router = new Hono();
// GET /api/bots — list bots for current tenant
router.get('/', async (c) => {
    const tenantId = c.get('tenantId');
    const rows = await db.select().from(bots).where(eq(bots.tenantId, tenantId));
    if (rows.length === 0)
        return c.json({ bots: [] });
    const chunkCounts = await db
        .select({ botId: botChunks.botId, total: count(botChunks.id) })
        .from(botChunks)
        .where(eq(botChunks.tenantId, tenantId))
        .groupBy(botChunks.botId);
    const countMap = new Map(chunkCounts.map(r => [r.botId, Number(r.total)]));
    return c.json({ bots: rows.map(b => ({ ...b, chunkCount: countMap.get(b.id) ?? 0 })) });
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
        .min(1)
        .max(50)
        .regex(/^[a-z0-9-]+$/),
    welcomeMessage: z.string().max(500).optional(),
    primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    systemPrompt: z.string().max(2000).nullable().optional(),
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
    headerLogoBg: z.string().nullable().optional(),
    botAvatarBg: z.string().nullable().optional(),
    launcherBg: z.string().nullable().optional(),
    tenantThemeId: z.string().uuid().nullable().optional(),
    headerSubtext: z.string().max(120).nullable().optional(),
    headerNameColor: z.string().nullable().optional(),
    headerBg: z.string().nullable().optional(),
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
    leadCaptureFields: z.array(z.object({
        id: z.string().max(50),
        label: z.string().max(100),
        type: z.enum(['text', 'email', 'tel']),
        required: z.boolean(),
        placeholder: z.string().max(100).optional(),
    })).optional(),
    llmModel: z.string().optional(),
    responseStyle: z.enum(['balanced', 'concise', 'very_concise', 'detailed', 'bullet_points', 'professional', 'friendly']).optional(),
    themeName: z.string().max(50).optional(),
    userBubbleColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
    botBubbleBg: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
    launcherSize: z.number().int().min(1).max(6).optional(),
    widgetPosition: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']).optional(),
    launcherTransparent: z.boolean().optional(),
    botAvatarUrl: z.string().url().nullable().optional(),
    headerLogoBg: z.string().nullable().optional(),
    botAvatarBg: z.string().nullable().optional(),
    launcherBg: z.string().nullable().optional(),
    tenantThemeId: z.string().uuid().nullable().optional(),
    headerSubtext: z.string().max(120).nullable().optional(),
    headerNameColor: z.string().nullable().optional(),
    headerBg: z.string().nullable().optional(),
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
const VALID_IMAGE_TYPES = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
};
const API_PUBLIC_URL = process.env.API_PUBLIC_URL ?? 'http://localhost:3001';
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_MB ?? '10', 10) * 1024 * 1024;
async function resizeImage(buffer, contentType, maxWidth, maxHeight) {
    if (contentType === 'image/svg+xml')
        return { buffer, contentType, ext: 'svg' };
    const resized = await sharp(buffer)
        .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
    return { buffer: resized, contentType: 'image/webp', ext: 'webp' };
}
// POST /api/bots/:id/logo — upload chat header logo directly
router.post('/:id/logo', async (c) => {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const contentType = c.req.header('content-type')?.split(';')[0].trim() ?? '';
    const ext = VALID_IMAGE_TYPES[contentType];
    if (!ext)
        return c.json({ error: 'Invalid image type. Use PNG, JPG, WEBP, or SVG.' }, 400);
    const [bot] = await db.select({ id: bots.id }).from(bots)
        .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
    if (!bot)
        return c.json({ error: 'Not found' }, 404);
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (raw.length > MAX_UPLOAD_BYTES)
        return c.json({ error: `File too large (max ${process.env.MAX_UPLOAD_MB ?? '10'} MB)` }, 413);
    const { buffer, contentType: outType, ext: outExt } = await resizeImage(raw, contentType, 800, 400);
    const s3Key = buildLogoKey(tenantId, id, outExt);
    await putObject(s3Key, buffer, outType);
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
    if (!ext)
        return c.json({ error: 'Invalid image type. Use PNG, JPG, WEBP, or SVG.' }, 400);
    const [bot] = await db.select({ id: bots.id }).from(bots)
        .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
    if (!bot)
        return c.json({ error: 'Not found' }, 404);
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (raw.length > MAX_UPLOAD_BYTES)
        return c.json({ error: `File too large (max ${process.env.MAX_UPLOAD_MB ?? '10'} MB)` }, 413);
    const { buffer, contentType: outType, ext: outExt } = await resizeImage(raw, contentType, 400, 400);
    const s3Key = `tenants/${tenantId}/bots/${id}/bot-avatar.${outExt}`;
    await putObject(s3Key, buffer, outType);
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
    if (!ext)
        return c.json({ error: 'Invalid image type. Use PNG, JPG, WEBP, or SVG.' }, 400);
    const [bot] = await db.select({ id: bots.id }).from(bots)
        .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
    if (!bot)
        return c.json({ error: 'Not found' }, 404);
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (raw.length > MAX_UPLOAD_BYTES)
        return c.json({ error: `File too large (max ${process.env.MAX_UPLOAD_MB ?? '10'} MB)` }, 413);
    const { buffer, contentType: outType, ext: outExt } = await resizeImage(raw, contentType, 400, 400);
    const s3Key = `tenants/${tenantId}/bots/${id}/launcher.${outExt}`;
    await putObject(s3Key, buffer, outType);
    const launcherLogoUrl = `${API_PUBLIC_URL}/api/logos/${s3Key}`;
    await db.update(bots).set({ launcherLogoUrl, updatedAt: new Date() }).where(eq(bots.id, id));
    return c.json({ launcherLogoUrl });
});
// GET /api/bots/:id/conversations — list conversations for a bot (paginated, date-filtered)
router.get('/:id/conversations', async (c) => {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const [bot] = await db.select({ id: bots.id }).from(bots)
        .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
    if (!bot)
        return c.json({ error: 'Not found' }, 404);
    const from = c.req.query('from');
    const to = c.req.query('to');
    const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)));
    const offset = (page - 1) * limit;
    const toDate = to ? new Date(to) : undefined;
    if (toDate)
        toDate.setHours(23, 59, 59, 999);
    const where = and(eq(conversations.botId, id), eq(conversations.tenantId, tenantId), from ? gte(conversations.startedAt, new Date(from)) : undefined, toDate ? lte(conversations.startedAt, toDate) : undefined);
    const [statsRow] = await db
        .select({
        totalConversations: count(conversations.id),
        totalMessages: sql `coalesce(sum(${conversations.messageCount}), 0)`,
        uniqueVisitors: sql `count(distinct ${conversations.visitorId})`,
        leadsCount: sql `count(case when ${conversations.visitorEmail} is not null then 1 end)`,
    })
        .from(conversations)
        .where(where);
    const rows = await db
        .select()
        .from(conversations)
        .where(where)
        .orderBy(desc(conversations.lastMessageAt))
        .limit(limit)
        .offset(offset);
    const total = Number(statsRow?.totalConversations ?? 0);
    return c.json({
        conversations: rows,
        stats: {
            totalConversations: total,
            totalMessages: Number(statsRow?.totalMessages ?? 0),
            uniqueVisitors: Number(statsRow?.uniqueVisitors ?? 0),
            leadsCount: Number(statsRow?.leadsCount ?? 0),
        },
        total,
        page,
        totalPages: Math.max(1, Math.ceil(total / limit)),
    });
});
// GET /api/bots/:id/conversations/export — CSV download
router.get('/:id/conversations/export', async (c) => {
    const tenantId = c.get('tenantId');
    const { id } = c.req.param();
    const [bot] = await db.select({ id: bots.id }).from(bots)
        .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
    if (!bot)
        return c.json({ error: 'Not found' }, 404);
    const from = c.req.query('from');
    const to = c.req.query('to');
    const toDate = to ? new Date(to) : undefined;
    if (toDate)
        toDate.setHours(23, 59, 59, 999);
    const where = and(eq(conversations.botId, id), eq(conversations.tenantId, tenantId), from ? gte(conversations.startedAt, new Date(from)) : undefined, toDate ? lte(conversations.startedAt, toDate) : undefined);
    const rows = await db.select().from(conversations).where(where)
        .orderBy(desc(conversations.lastMessageAt)).limit(10000);
    const csvHeaders = ['ID', 'Name', 'Email', 'Phone', 'Messages', 'Started At', 'Last Message At', 'Visitor ID'];
    const csvRows = rows.map((r) => [
        r.id, r.visitorName ?? '', r.visitorEmail ?? '', r.visitorPhone ?? '',
        r.messageCount, r.startedAt?.toISOString() ?? '', r.lastMessageAt?.toISOString() ?? '', r.visitorId ?? '',
    ]);
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [csvHeaders, ...csvRows].map(row => row.map(escape).join(',')).join('\n');
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="conversations.csv"`);
    return c.text(csv);
});
// GET /api/bots/:id/conversations/:conversationId/messages
router.get('/:id/conversations/:conversationId/messages', async (c) => {
    const tenantId = c.get('tenantId');
    const { id, conversationId } = c.req.param();
    const [conv] = await db.select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.botId, id), eq(conversations.tenantId, tenantId)))
        .limit(1);
    if (!conv)
        return c.json({ error: 'Not found' }, 404);
    const msgs = await db.select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt));
    return c.json({ messages: msgs });
});
export default router;
//# sourceMappingURL=bots.js.map