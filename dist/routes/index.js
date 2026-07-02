import { Hono } from 'hono';
import { authMiddleware, requireSuperAdmin, requireTenant } from '../middleware/auth.js';
import authRouter from './auth.js';
import registerRouter from './register.js';
import adminTenantsRouter from './admin/tenants.js';
import adminAnalyticsRouter from './admin/analytics.js';
import adminBotAvatarsRouter from './admin/bot-avatars.js';
import botsRouter from './bots.js';
import documentsRouter from './documents.js';
import chatRouter from './chat.js';
import widgetRouter from './widget.js';
import accountRouter from './account.js';
import logosRouter from './logos.js';
import tenantThemesRouter from './tenant-themes.js';
const api = new Hono();
// ─── Public routes ─────────────────────────────────────────────────────────────
api.route('/auth', authRouter);
api.route('/auth/register', registerRouter);
api.route('/widget-config', widgetRouter);
api.route('/chat', chatRouter);
api.route('/logos', logosRouter);
// ─── Authenticated routes ──────────────────────────────────────────────────────
const protected_ = new Hono();
protected_.use('*', authMiddleware);
// Super-admin only
protected_
    .use('/admin/*', requireSuperAdmin)
    .route('/admin/tenants', adminTenantsRouter)
    .route('/admin/analytics', adminAnalyticsRouter)
    .route('/admin/bot-avatars', adminBotAvatarsRouter);
// Client-tenant routes (bots, documents, account)
protected_
    .use('/bots/*', requireTenant)
    .use('/documents/*', requireTenant)
    .use('/themes/*', requireTenant)
    .route('/bots', botsRouter)
    .route('/documents', documentsRouter)
    .route('/account', accountRouter)
    .route('/themes', tenantThemesRouter);
// Bot avatar presets — readable by any authenticated user (used in bot creation wizard)
protected_.get('/bot-avatar-presets', async (c) => {
    const { db, botAvatarPresets } = await import('../db/index.js');
    const { asc } = await import('drizzle-orm');
    const presets = await db
        .select()
        .from(botAvatarPresets)
        .orderBy(asc(botAvatarPresets.displayOrder), asc(botAvatarPresets.createdAt));
    return c.json({ presets });
});
api.route('/', protected_);
export default api;
//# sourceMappingURL=index.js.map