import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import apiRoutes from './routes/index.js';
import bookingPages from './booking/pages/router.js';
import { startBookingWorker } from './booking/runner.js';
import { refreshPlanModelCache } from './lib/planModels.js';

const app = new Hono();

// ─── Global Middleware ─────────────────────────────────────────────────────────
app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'x-preset-name'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length'],
  })
);

app.use('*', logger());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (c) =>
  c.json({ status: 'ok', service: 'cloudgeniee-api', ts: new Date().toISOString() })
);

// ─── API Routes ────────────────────────────────────────────────────────────────
app.route('/api', apiRoutes);
// Hosted booking pages (manage / approve / booking page) — book.cloudgeniee.com proxies here.
app.route('/book', bookingPages);

// ─── Error handler ────────────────────────────────────────────────────────────
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.API_PORT ?? process.env.PORT ?? '3001');

serve({ fetch: app.fetch, port: PORT }, (info) => {
  // Booking emails/reminders run in this process unless a separate worker is configured.
  if (process.env.BOOKING_WORKER !== 'external') startBookingWorker();
  void refreshPlanModelCache().catch((err) => console.error('Failed to load plan model config:', err));
  console.log(`CloudGeniee API running on http://localhost:${info.port}`);
  console.log(`Environment: ${process.env.NODE_ENV ?? 'development'}`);
});
