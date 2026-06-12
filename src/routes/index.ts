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
import logosRouter from './logos.js';
import type { HonoEnv } from '../types/index.js';

const api = new Hono<HonoEnv>();

// ─── Public routes ─────────────────────────────────────────────────────────────
api.route('/auth', authRouter);
api.route('/auth/register', registerRouter);
api.route('/widget-config', widgetRouter);
api.route('/chat', chatRouter);
api.route('/logos', logosRouter);

// ─── Authenticated routes ──────────────────────────────────────────────────────
const protected_ = new Hono<HonoEnv>();
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
