import { Hono } from 'hono';
import { jsonBody } from '../lib/validation.js';
import { z } from 'zod';
import { db, bots, botChunks, botDocuments, conversations, messages, tenants } from '../db/index.js';
import { eq, and, count, desc, gte, lte, asc, sql } from 'drizzle-orm';
import { putObject, buildLogoKey } from '../lib/s3.js';
import sharp from 'sharp';
import type { HonoEnv } from '../types/index.js';
import { PLAN_CONFIG, isPlanId } from '../config/plans.js';
import { ttsSpeak } from '../lib/deepgram.js';

const router = new Hono<HonoEnv>();

// GET /api/bots — list bots for current tenant
router.get('/', async (c) => {
  const tenantId = c.get('tenantId');
  const rows = await db.select().from(bots).where(eq(bots.tenantId, tenantId));
  if (rows.length === 0) return c.json({ bots: [] });

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

  if (!bot) return c.json({ error: 'Not found' }, 404);
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
  systemPrompt: z.string().max(4000).nullable().optional(),
  allowedOrigins: z.array(z.string().url()).default([]),
  leadCaptureEnabled: z.boolean().default(false),
  leadCaptureMessage: z.string().max(300).optional(),
  bookingEnabled: z.boolean().optional(),
  voiceEnabled: z.boolean().optional(),
  voiceId: z.string().max(50).optional(),
  voiceIntro: z.string().max(300).nullable().optional(),
  status: z.enum(['active', 'inactive', 'draft']).optional(),
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

router.post('/', jsonBody(createBotSchema), async (c) => {
  const tenantId = c.get('tenantId');
  const body = c.req.valid('json');

  const [tenant] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const plan = isPlanId(tenant?.plan) ? PLAN_CONFIG[tenant.plan] : PLAN_CONFIG.starter;

  if (body.leadCaptureEnabled && !plan.leadCaptureAllowed) {
    return c.json({ error: 'Lead capture requires a paid plan. Upgrade in Settings to enable it.' }, 403);
  }

  // Drafts are free and don't count toward the limit; only enforce the cap when creating an active bot.
  if (body.status !== 'draft' && body.status !== 'inactive') {
    const [{ total: botCount }] = await db
      .select({ total: count(bots.id) })
      .from(bots)
      .where(and(eq(bots.tenantId, tenantId), eq(bots.status, 'active')));

    if (Number(botCount) >= plan.maxBots) {
      return c.json({ error: `Your ${plan.label} plan allows up to ${plan.maxBots} bot${plan.maxBots === 1 ? '' : 's'}. Upgrade to create more.` }, 403);
    }
  }

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
  systemPrompt: z.string().max(4000).nullable().optional(),
  allowedOrigins: z.array(z.string()).optional(),
  status: z.enum(['active', 'inactive', 'draft']).optional(),
  leadCaptureEnabled: z.boolean().optional(),
  leadCaptureMessage: z.string().max(300).optional(),
  leadCaptureFields: z.array(z.object({
    id: z.string().max(50),
    label: z.string().max(100),
    type: z.enum(['text', 'email', 'tel']),
    required: z.boolean(),
    placeholder: z.string().max(100).optional(),
  })).optional(),
  bookingEnabled: z.boolean().optional(),
  voiceEnabled: z.boolean().optional(),
  voiceId: z.string().max(50).optional(),
  voiceIntro: z.string().max(300).nullable().optional(),
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

router.put('/:id', jsonBody(updateBotSchema), async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();
  const body = c.req.valid('json');

  if (body.leadCaptureEnabled || body.status === 'active') {
    const [tenant] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    const plan = isPlanId(tenant?.plan) ? PLAN_CONFIG[tenant.plan] : PLAN_CONFIG.starter;

    if (body.leadCaptureEnabled && !plan.leadCaptureAllowed) {
      return c.json({ error: 'Lead capture requires a paid plan. Upgrade in Settings to enable it.' }, 403);
    }

    // Publishing/activating a bot: enforce the plan's active-bot cap (excluding this bot itself).
    if (body.status === 'active') {
      const [current] = await db.select({ status: bots.status }).from(bots)
        .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
      if (current && current.status !== 'active') {
        const [{ total: activeCount }] = await db
          .select({ total: count(bots.id) })
          .from(bots)
          .where(and(eq(bots.tenantId, tenantId), eq(bots.status, 'active')));
        if (Number(activeCount) >= plan.maxBots) {
          return c.json({ error: `Your ${plan.label} plan allows up to ${plan.maxBots} active bot${plan.maxBots === 1 ? '' : 's'}. Upgrade or deactivate another bot first.` }, 403);
        }
      }
    }
  }

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

// POST /api/bots/:id/voice-preview — owner previews any voice (no save / voiceEnabled needed)
router.post('/:id/voice-preview', async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();
  const [bot] = await db.select({ voiceId: bots.voiceId }).from(bots)
    .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
  if (!bot) return c.json({ error: 'Not found' }, 404);

  const body = await c.req.json<{ text?: string; voice?: string }>().catch(() => ({} as any));
  const text = (body.text ?? '').trim().slice(0, 500);
  if (!text) return c.json({ error: 'text required' }, 400);
  try {
    const audio = await ttsSpeak(text, body.voice || bot.voiceId);
    const ab = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
    c.header('Content-Type', 'audio/mpeg');
    c.header('Cache-Control', 'no-store');
    return c.body(ab);
  } catch (err: any) {
    console.error('voice-preview error:', err?.message ?? err);
    return c.json({ error: 'TTS failed' }, 502);
  }
});

// DELETE /api/bots/:id/conversations — wipe this bot's chat history (messages cascade from conversations)
router.delete('/:id/conversations', async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();

  const [bot] = await db.select({ id: bots.id }).from(bots)
    .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
  if (!bot) return c.json({ error: 'Not found' }, 404);

  await db.delete(conversations).where(and(eq(conversations.botId, id), eq(conversations.tenantId, tenantId)));
  return c.json({ success: true });
});

// DELETE /api/bots/:id/knowledge — wipe this bot's indexed documents + vector chunks (DB rows only)
router.delete('/:id/knowledge', async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();

  const [bot] = await db.select({ id: bots.id }).from(bots)
    .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
  if (!bot) return c.json({ error: 'Not found' }, 404);

  await db.delete(botChunks).where(and(eq(botChunks.botId, id), eq(botChunks.tenantId, tenantId)));
  await db.delete(botDocuments).where(and(eq(botDocuments.botId, id), eq(botDocuments.tenantId, tenantId)));
  return c.json({ success: true });
});

const VALID_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

const API_PUBLIC_URL = process.env.API_PUBLIC_URL ?? 'http://localhost:3001';
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_MB ?? '10', 10) * 1024 * 1024;

async function resizeImage(buffer: Buffer, contentType: string, maxWidth: number, maxHeight: number): Promise<{ buffer: Buffer; contentType: string; ext: string }> {
  if (contentType === 'image/svg+xml') return { buffer, contentType, ext: 'svg' };
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
  if (!ext) return c.json({ error: 'Invalid image type. Use PNG, JPG, WEBP, or SVG.' }, 400);

  const [bot] = await db.select({ id: bots.id }).from(bots)
    .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
  if (!bot) return c.json({ error: 'Not found' }, 404);

  const raw = Buffer.from(await c.req.arrayBuffer());
  if (raw.length > MAX_UPLOAD_BYTES) return c.json({ error: `File too large (max ${process.env.MAX_UPLOAD_MB ?? '10'} MB)` }, 413);

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
  if (!ext) return c.json({ error: 'Invalid image type. Use PNG, JPG, WEBP, or SVG.' }, 400);

  const [bot] = await db.select({ id: bots.id }).from(bots)
    .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
  if (!bot) return c.json({ error: 'Not found' }, 404);

  const raw = Buffer.from(await c.req.arrayBuffer());
  if (raw.length > MAX_UPLOAD_BYTES) return c.json({ error: `File too large (max ${process.env.MAX_UPLOAD_MB ?? '10'} MB)` }, 413);

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
  if (!ext) return c.json({ error: 'Invalid image type. Use PNG, JPG, WEBP, or SVG.' }, 400);

  const [bot] = await db.select({ id: bots.id }).from(bots)
    .where(and(eq(bots.id, id), eq(bots.tenantId, tenantId))).limit(1);
  if (!bot) return c.json({ error: 'Not found' }, 404);

  const raw = Buffer.from(await c.req.arrayBuffer());
  if (raw.length > MAX_UPLOAD_BYTES) return c.json({ error: `File too large (max ${process.env.MAX_UPLOAD_MB ?? '10'} MB)` }, 413);

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
  if (!bot) return c.json({ error: 'Not found' }, 404);

  const from = c.req.query('from');
  const to = c.req.query('to');
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)));
  const offset = (page - 1) * limit;

  const toDate = to ? new Date(to) : undefined;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  const where = and(
    eq(conversations.botId, id),
    eq(conversations.tenantId, tenantId),
    from ? gte(conversations.startedAt, new Date(from)) : undefined,
    toDate ? lte(conversations.startedAt, toDate) : undefined,
  );

  const [statsRow] = await db
    .select({
      totalConversations: count(conversations.id),
      totalMessages: sql<number>`coalesce(sum(${conversations.messageCount}), 0)`,
      uniqueVisitors: sql<number>`count(distinct coalesce(${conversations.visitorId}, ${conversations.id}::text))`,
      leadsCount: sql<number>`count(case when ${conversations.visitorEmail} is not null then 1 end)`,
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
  if (!bot) return c.json({ error: 'Not found' }, 404);

  const from = c.req.query('from');
  const to = c.req.query('to');
  const toDate = to ? new Date(to) : undefined;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  const where = and(
    eq(conversations.botId, id),
    eq(conversations.tenantId, tenantId),
    from ? gte(conversations.startedAt, new Date(from)) : undefined,
    toDate ? lte(conversations.startedAt, toDate) : undefined,
  );

  const rows = await db.select().from(conversations).where(where)
    .orderBy(desc(conversations.lastMessageAt)).limit(10000);

  const fmtDate = (d: Date | null) => {
    if (!d) return '';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  };
  const fmtDur = (start: Date, end: Date) => {
    const diff = Math.floor((end.getTime() - start.getTime()) / 1000);
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
    return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  };

  const data = rows.map((r: any) => {
    const base: Record<string, any> = {
      Name: r.visitorName || '',
      Email: r.visitorEmail || '',
      Phone: r.visitorPhone || '',
      Messages: r.messageCount,
      Duration: r.messageCount > 1 ? fmtDur(r.startedAt, r.lastMessageAt) : '',
      'Started At': fmtDate(r.startedAt),
    };
    if (r.leadData && typeof r.leadData === 'object') {
      for (const [k, v] of Object.entries(r.leadData as Record<string, string>)) {
        base[k.charAt(0).toUpperCase() + k.slice(1)] = v;
      }
    }
    return base;
  });

  const [botRow] = await db.select({ name: bots.name }).from(bots).where(eq(bots.id, id)).limit(1);

  return c.json({ botName: botRow?.name ?? 'Bot', total: data.length, conversations: data });
});

// GET /api/bots/:id/conversations/:conversationId/messages
router.get('/:id/conversations/:conversationId/messages', async (c) => {
  const tenantId = c.get('tenantId');
  const { id, conversationId } = c.req.param();

  const [conv] = await db.select({ id: conversations.id })
    .from(conversations)
    .where(and(
      eq(conversations.id, conversationId),
      eq(conversations.botId, id),
      eq(conversations.tenantId, tenantId),
    ))
    .limit(1);
  if (!conv) return c.json({ error: 'Not found' }, 404);

  const msgs = await db.select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));

  return c.json({ messages: msgs });
});

export default router;
