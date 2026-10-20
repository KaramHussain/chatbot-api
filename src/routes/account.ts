import { Hono } from 'hono';
import { db, tenants, users, bots, botChunks, botDocuments, conversations } from '../db/index.js';
import { eq, sql, and, gte, count } from 'drizzle-orm';
import type { HonoEnv } from '../types/index.js';
import { PLAN_CONFIG, isPlanId } from '../config/plans.js';

const router = new Hono<HonoEnv>();

// DELETE /api/account/data — wipe RAG/conversation data, keep account
router.delete('/data', async (c) => {
  const user = c.get('user');
  if (!user.tenantId) return c.json({ error: 'No tenant' }, 400);

  await db.delete(botChunks).where(eq(botChunks.tenantId, user.tenantId));
  await db.delete(botDocuments).where(eq(botDocuments.tenantId, user.tenantId));
  await db.delete(conversations).where(eq(conversations.tenantId, user.tenantId));

  return c.json({ success: true });
});

// DELETE /api/account — delete own account + all associated data
router.delete('/', async (c) => {
  const user = c.get('user');
  if (!user.tenantId) return c.json({ error: 'Only tenant admins can delete their account' }, 400);

  // Delete tenant → cascades to bots, documents, chunks, conversations, messages, users
  await db.delete(tenants).where(eq(tenants.id, user.tenantId));

  return c.json({ success: true });
});

// GET /api/account/settings — return tenant settings for this user
router.get('/settings', async (c) => {
  const user = c.get('user');
  if (!user.tenantId) return c.json({ error: 'No tenant' }, 400);

  const [tenant] = await db.select({
    sessionDurationMinutes: tenants.sessionDurationMinutes,
    monthlyTokenBudget: tenants.monthlyTokenBudget,
    tokensUsedThisMonth: tenants.tokensUsedThisMonth,
    monthlyMessageLimit: tenants.monthlyMessageLimit,
    messagesThisMonth: tenants.messagesThisMonth,
    plan: tenants.plan,
    aiModel: tenants.aiModel,
  }).from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);

  if (!tenant) return c.json({ error: 'No tenant' }, 404);

  const [{ total: botsUsed }] = await db.select({ total: count(bots.id) }).from(bots).where(eq(bots.tenantId, user.tenantId));
  const plan = isPlanId(tenant.plan) ? PLAN_CONFIG[tenant.plan] : PLAN_CONFIG.starter;

  return c.json({ settings: { ...tenant, botsUsed: Number(botsUsed), maxBots: plan.maxBots } });
});

// POST /api/account/plan — switch subscription tier (no payment gateway yet: activates immediately)
router.post('/plan', async (c) => {
  const user = c.get('user');
  if (!user.tenantId) return c.json({ error: 'No tenant' }, 400);

  const body = await c.req.json<{ plan?: string }>();
  if (!isPlanId(body.plan)) return c.json({ error: 'Invalid plan' }, 400);

  const config = PLAN_CONFIG[body.plan];

  await db.update(tenants)
    .set({
      plan: body.plan,
      monthlyMessageLimit: config.monthlyMessageLimit,
      monthlyTokenBudget: config.monthlyTokenBudget,
      aiModel: config.aiModel,
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, user.tenantId));

  return c.json({ success: true, plan: body.plan });
});

// PATCH /api/account/settings — tenant can update their own session duration
router.patch('/settings', async (c) => {
  const user = c.get('user');
  if (!user.tenantId) return c.json({ error: 'No tenant' }, 400);

  const body = await c.req.json<{ sessionDurationMinutes?: number }>();
  const { sessionDurationMinutes } = body;

  if (typeof sessionDurationMinutes !== 'number' || sessionDurationMinutes < 1 || sessionDurationMinutes > 43200) {
    return c.json({ error: 'Invalid sessionDurationMinutes (1–43200)' }, 400);
  }

  await db.update(tenants)
    .set({ sessionDurationMinutes, updatedAt: new Date() })
    .where(eq(tenants.id, user.tenantId));

  return c.json({ success: true });
});

// GET /api/account/analytics — 30-day daily conversation + lead counts across all bots
router.get('/analytics', async (c) => {
  const user = c.get('user');
  if (!user.tenantId) return c.json({ error: 'No tenant' }, 400);

  const since = new Date();
  since.setDate(since.getDate() - 29);
  since.setHours(0, 0, 0, 0);

  const rows = await db
    .select({
      date: sql<string>`DATE(${conversations.startedAt})::text`,
      conversations: count(conversations.id),
      leads: sql<number>`count(case when ${conversations.visitorEmail} is not null then 1 end)`,
    })
    .from(conversations)
    .where(and(
      eq(conversations.tenantId, user.tenantId),
      gte(conversations.startedAt, since),
    ))
    .groupBy(sql`DATE(${conversations.startedAt})`)
    .orderBy(sql`DATE(${conversations.startedAt})`);

  const [totalsRow] = await db
    .select({
      totalConversations: count(conversations.id),
      totalLeads: sql<number>`count(case when ${conversations.visitorEmail} is not null then 1 end)`,
      totalMessages: sql<number>`coalesce(sum(${conversations.messageCount}), 0)`,
    })
    .from(conversations)
    .where(eq(conversations.tenantId, user.tenantId));

  return c.json({
    daily: rows.map(r => ({ date: r.date, conversations: Number(r.conversations), leads: Number(r.leads) })),
    totals: {
      conversations: Number(totalsRow?.totalConversations ?? 0),
      leads: Number(totalsRow?.totalLeads ?? 0),
      messages: Number(totalsRow?.totalMessages ?? 0),
    },
  });
});

export default router;
