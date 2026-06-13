import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import apiRoutes from './routes/index.js';

const app = new Hono();

// ─── Global Middleware ─────────────────────────────────────────────────────────
app.use(
  '*',
  cors({
    origin: (origin, c) => {
      // Widget and chat endpoints are embedded on third-party sites — allow any origin.
      const path = c.req.path;
      if (path.startsWith('/api/widget-config/') || path.startsWith('/api/chat/')) {
        return origin;
      }
      // In development, allow all.
      if (process.env.NODE_ENV !== 'production') return origin;
      // Dashboard / admin endpoints — restrict to known origins.
      const allowed = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim());
      return allowed.includes(origin) ? origin : null;
    },
    allowHeaders: ['Content-Type', 'Authorization', 'x-preset-name'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length'],
    credentials: true,
  })
);

app.use('*', logger());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (c) =>
  c.json({ status: 'ok', service: 'cloudgeniee-api', ts: new Date().toISOString() })
);

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
