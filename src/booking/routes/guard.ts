// Shared bits for owner routes: bot ownership guard, validation helpers and error mapping.
import { and, eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { bots, db } from '../../db/index.js';
import type { HonoEnv } from '../../types/index.js';
import { BookingError } from '../core.js';

export type BotRow = typeof bots.$inferSelect;
export type BookingOwnerEnv = { Variables: HonoEnv['Variables'] & { bot: BotRow } };

/** The bot in the URL must belong to the caller's tenant. */
export const botGuard = createMiddleware<BookingOwnerEnv>(async (c, next) => {
  const [bot] = await db.select().from(bots)
    .where(and(eq(bots.id, c.req.param('id') ?? ''), eq(bots.tenantId, c.get('tenantId')))).limit(1);
  if (!bot) return c.json({ error: 'Bot not found' }, 404);
  c.set('bot', bot);
  await next();
});

/** Maps domain errors to JSON responses; anything else is rethrown. */
export function handleError(c: Context, err: unknown) {
  if (err instanceof BookingError) return c.json({ error: err.message, code: err.code }, err.status as 400 | 403 | 404 | 409 | 429);
  throw err;
}

export const uuidParam = (v: string | undefined) => /^[0-9a-f-]{36}$/i.test(v ?? '');

export function parseDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export const intParam = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};
