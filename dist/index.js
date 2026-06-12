import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import apiRoutes from './routes/index.js';
const app = new Hono();
// ─── Global Middleware ─────────────────────────────────────────────────────────
app.use('*', cors({
    origin: (origin) => {
        // In development, allow all. In production, lock to specific origins.
        if (process.env.NODE_ENV !== 'production')
            return origin;
        // Dashboard origin — set this in env
        const allowed = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim());
        return allowed.includes(origin) ? origin : null;
    },
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length'],
    credentials: true,
}));
app.use('*', logger());
// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (c) => c.json({ status: 'ok', service: 'cloudgeniee-api', ts: new Date().toISOString() }));
// ─── API Routes ────────────────────────────────────────────────────────────────
app.route('/api', apiRoutes);
// ─── Error handler ────────────────────────────────────────────────────────────
app.onError((err, c) => {
    if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status);
    }
    console.error('Unhandled error:', err);
    return c.json({ error: 'Internal server error' }, 500);
});
// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.API_PORT ?? '3001');
serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`CloudGeniee API running on http://localhost:${info.port}`);
    console.log(`Environment: ${process.env.NODE_ENV ?? 'development'}`);
});
//# sourceMappingURL=index.js.map