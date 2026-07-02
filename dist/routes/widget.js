import { Hono } from 'hono';
import { db, bots, tenants, tenantThemes } from '../db/index.js';
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
        leadCaptureFields: bots.leadCaptureFields,
        status: bots.status,
        themeName: bots.themeName,
        userBubbleColor: bots.userBubbleColor,
        botBubbleBg: bots.botBubbleBg,
        launcherSize: bots.launcherSize,
        widgetPosition: bots.widgetPosition,
        launcherTransparent: bots.launcherTransparent,
        headerLogoBg: bots.headerLogoBg,
        botAvatarBg: bots.botAvatarBg,
        launcherBg: bots.launcherBg,
        tenantThemeId: bots.tenantThemeId,
        headerSubtext: bots.headerSubtext,
        headerNameColor: bots.headerNameColor,
        headerBg: bots.headerBg,
        sessionDurationMinutes: tenants.sessionDurationMinutes,
    })
        .from(bots)
        .innerJoin(tenants, eq(bots.tenantId, tenants.id))
        .where(and(eq(bots.id, botId), eq(bots.status, 'active')))
        .limit(1);
    if (!row)
        return c.json({ error: 'Bot not found' }, 404);
    const { sessionDurationMinutes, tenantThemeId, ...config } = row;
    // If bot uses a custom tenant theme, resolve and inline all color values
    if (tenantThemeId) {
        const [customTheme] = await db
            .select()
            .from(tenantThemes)
            .where(eq(tenantThemes.id, tenantThemeId))
            .limit(1);
        if (customTheme) {
            Object.assign(config, {
                themeName: 'Custom',
                primaryColor: customTheme.primaryColor,
                userBubbleColor: customTheme.userBubbleColor,
                botBubbleBg: customTheme.botBubbleBg,
                botTextColor: customTheme.botTextColor,
                windowBg: customTheme.windowBg,
                inputBg: customTheme.inputBg,
                userText: customTheme.userText,
                headerLogoBg: customTheme.headerLogoBg ?? config.headerLogoBg,
                headerTextColor: customTheme.headerTextColor ?? null,
            });
        }
    }
    c.header('Cache-Control', 'no-store, max-age=0');
    return c.json({ config, sessionDurationMinutes });
});
export default router;
//# sourceMappingURL=widget.js.map