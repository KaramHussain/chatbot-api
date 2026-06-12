import { Hono } from 'hono';
import { authMiddleware, requireSuperAdmin, requireTenant } from '../middleware/auth.js';
import authRouter from './auth.js';
import registerRouter from './register.js';
import adminTenantsRouter from './admin/tenants.js';
import adminAnalyticsRouter from './admin/analytics.js';
import botsRouter from './bots.js';
import documentsRouter from './documents.js';
import chatRouter from './chat.js';
import widgetRouter from './widget.js';
import accountRouter from './account.js';
const api = new Hono();
// ─── Public routes ─────────────────────────────────────────────────────────────
api.route('/auth', authRouter);
api.route('/auth/register', registerRouter);
api.route('/widget-config', widgetRouter);
api.route('/chat', chatRouter);
// ─── Authenticated routes ──────────────────────────────────────────────────────
const protected_ = new Hono();
protected_.use('*', authMiddleware);
// Super-admin only
protected_
    .use('/admin/*', requireSuperAdmin)
    .route('/admin/tenants', adminTenantsRouter)
    .route('/admin/analytics', adminAnalyticsRouter);
// Client-tenant routes
protected_
    .use('/bots/*', requireTenant)
    .use('/documents/*', requireTenant)
    .route('/bots', botsRouter)
    .route('/documents', documentsRouter)
    .route('/account', accountRouter);
api.route('/', protected_);
export default api;
//# sourceMappingURL=index.js.map