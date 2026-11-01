// Public, token-protected calendar feed (ICS). Owners subscribe to it from Google/Apple/Outlook
// calendar on their phone and see bookings without any OAuth connection.
import { and, eq, gte, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { bots, db } from '../../db/index.js';
import { tenantHasBooking } from '../entitlements.js';
import { bookings, bookingSettings } from '../schema.js';
import { brandFor, dashboardBookingUrl } from '../notify/notifier.js';
import { bookingsIcs } from '../exports.js';
import { verifyFeedToken } from '../tokens.js';

const router = new Hono();

router.get('/:file', async (c) => {
  const token = c.req.param('file').replace(/\.ics$/, '');
  const parsed = verifyFeedToken(token);
  if (!parsed) return c.text('Not found', 404);
  const [settings] = await db.select().from(bookingSettings).where(eq(bookingSettings.botId, parsed.botId)).limit(1);
  if (!settings || settings.feedVersion !== parsed.version || !(await tenantHasBooking(settings.tenantId))) return c.text('Not found', 404);
  const [bot] = await db.select().from(bots).where(eq(bots.id, parsed.botId)).limit(1);
  if (!bot) return c.text('Not found', 404);

  const since = new Date(Date.now() - 30 * 86400_000);
  const rows = await db.select().from(bookings).where(and(
    eq(bookings.botId, bot.id), inArray(bookings.status, ['confirmed', 'pending', 'completed', 'no_show']), gte(bookings.startsAt, since),
  ));
  const brand = brandFor(bot, settings);
  c.header('Content-Type', 'text/calendar; charset=utf-8');
  c.header('Cache-Control', 'private, max-age=300');
  return c.body(bookingsIcs(rows, { calendarName: `${brand.name} · ChatGeniee bookings`, organizerEmail: '', businessName: brand.name, dashboardUrl: (b) => dashboardBookingUrl(b.botId, b.id) }));
});

export default router;
