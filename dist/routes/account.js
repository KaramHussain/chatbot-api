import { Hono } from 'hono';
import { db, tenants, botChunks, botDocuments, conversations } from '../db/index.js';
import { eq } from 'drizzle-orm';
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
    return c.json({ settings: tenant });
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
export default router;
//# sourceMappingURL=account.js.map