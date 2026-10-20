import { Hono } from 'hono';
import { db, tenants, bots, botChunks, botDocuments, conversations } from '../db/index.js';
import { eq, sql, and, gte, count, asc } from 'drizzle-orm';
import { PLAN_CONFIG, isPlanId } from '../config/plans.js';
const router = new Hono();
// DELETE /api/account/data — wipe RAG/conversation data, keep account
router.delete('/data', async (c) => {
    const user = c.get('user');
    if (!user.tenantId)
        return c.json({ error: 'No tenant' }, 400);
    await db.delete(botChunks).where(eq(botChunks.tenantId, user.tenantId));
    await db.delete(botDocuments).where(eq(botDocuments.tenantId, user.tenantId));
    await db.delete(conversations).where(eq(conversations.tenantId, user.tenantId));
    return c.json({ success: true });
});
// DELETE /api/account — delete own account + all associated data
router.delete('/', async (c) => {
    const user = c.get('user');
    if (!user.tenantId)
        return c.json({ error: 'Only tenant admins can delete their account' }, 400);
    // Delete tenant → cascades to bots, documents, chunks, conversations, messages, users
    await db.delete(tenants).where(eq(tenants.id, user.tenantId));
    return c.json({ success: true });
});
// GET /api/account/settings — return tenant settings for this user
router.get('/settings', async (c) => {
    const user = c.get('user');
    if (!user.tenantId)
        return c.json({ error: 'No tenant' }, 400);
    const [tenant] = await db.select({
        sessionDurationMinutes: tenants.sessionDurationMinutes,
        monthlyTokenBudget: tenants.monthlyTokenBudget,
        tokensUsedThisMonth: tenants.tokensUsedThisMonth,
        monthlyMessageLimit: tenants.monthlyMessageLimit,
        messagesThisMonth: tenants.messagesThisMonth,
        plan: tenants.plan,
        aiModel: tenants.aiModel,
    }).from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
    if (!tenant)
        return c.json({ error: 'No tenant' }, 404);
    const [{ total: botsUsed }] = await db.select({ total: count(bots.id) }).from(bots).where(and(eq(bots.tenantId, user.tenantId), eq(bots.status, 'active')));
    const plan = isPlanId(tenant.plan) ? PLAN_CONFIG[tenant.plan] : PLAN_CONFIG.starter;
    return c.json({ settings: { ...tenant, botsUsed: Number(botsUsed), maxBots: plan.maxBots } });
});
// POST /api/account/plan — switch subscription tier (no payment gateway yet: activates immediately)
router.post('/plan', async (c) => {
    const user = c.get('user');
    if (!user.tenantId)
        return c.json({ error: 'No tenant' }, 400);
    const body = await c.req.json();
    if (!isPlanId(body.plan))
        return c.json({ error: 'Invalid plan' }, 400);
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
    // Keep the oldest `maxBots` bots active for this plan; deactivate (don't delete) the rest.
    // Re-syncing on every plan change also reactivates bots that a prior downgrade had switched off,
    // in the same oldest-first order, if the new plan's limit allows it.
    const tenantBots = await db
        .select({ id: bots.id, status: bots.status })
        .from(bots)
        .where(eq(bots.tenantId, user.tenantId))
        .orderBy(asc(bots.createdAt));
    const toActivate = tenantBots.slice(0, config.maxBots).filter(b => b.status !== 'active').map(b => b.id);
    const toDeactivate = tenantBots.slice(config.maxBots).filter(b => b.status === 'active').map(b => b.id);
    for (const id of toActivate) {
        await db.update(bots).set({ status: 'active', updatedAt: new Date() }).where(eq(bots.id, id));
    }
    for (const id of toDeactivate) {
        await db.update(bots).set({ status: 'inactive', updatedAt: new Date() }).where(eq(bots.id, id));
    }
    return c.json({ success: true, plan: body.plan, deactivatedBots: toDeactivate.length });
});
// PATCH /api/account/settings — tenant can update their own session duration
router.patch('/settings', async (c) => {
    const user = c.get('user');
    if (!user.tenantId)
        return c.json({ error: 'No tenant' }, 400);
    const body = await c.req.json();
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
    if (!user.tenantId)
        return c.json({ error: 'No tenant' }, 400);
    const since = new Date();
    since.setDate(since.getDate() - 29);
    since.setHours(0, 0, 0, 0);
    const rows = await db
        .select({
        date: sql `DATE(${conversations.startedAt})::text`,
        conversations: count(conversations.id),
        leads: sql `count(case when ${conversations.visitorEmail} is not null then 1 end)`,
    })
        .from(conversations)
        .where(and(eq(conversations.tenantId, user.tenantId), gte(conversations.startedAt, since)))
        .groupBy(sql `DATE(${conversations.startedAt})`)
        .orderBy(sql `DATE(${conversations.startedAt})`);
    const [totalsRow] = await db
        .select({
        totalConversations: count(conversations.id),
        totalLeads: sql `count(case when ${conversations.visitorEmail} is not null then 1 end)`,
        totalMessages: sql `coalesce(sum(${conversations.messageCount}), 0)`,
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
//# sourceMappingURL=account.js.map