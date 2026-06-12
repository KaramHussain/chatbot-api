import { Hono } from 'hono';
import { db, bots, tenants } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
const router = new Hono();
// GET /api/widget-config/:botId — public, no auth
router.get('/:botId', async (c) => {
    const { botId } = c.req.param();
    const [row] = await db
        .select({
        id: bots.id,
        name: bots.name,
        displayName: bots.displayName,
        welcomeMessage: bots.welcomeMessage,
        primaryColor: bots.primaryColor,
        logoUrl: bots.logoUrl,
        botAvatarUrl: bots.botAvatarUrl,
        launcherLogoUrl: bots.launcherLogoUrl,
        leadCaptureEnabled: bots.leadCaptureEnabled,
        leadCaptureMessage: bots.leadCaptureMessage,
        status: bots.status,
        sessionDurationMinutes: tenants.sessionDurationMinutes,
    })
        .from(bots)
        .innerJoin(tenants, eq(bots.tenantId, tenants.id))
        .where(and(eq(bots.id, botId), eq(bots.status, 'active')))
        .limit(1);
    if (!row)
        return c.json({ error: 'Bot not found' }, 404);
    const { sessionDurationMinutes, ...config } = row;
    return c.json({ config, sessionDurationMinutes });
});
export default router;
//# sourceMappingURL=widget.js.map