// Hosted booking pages, mounted at /book (book.cloudgeniee.com proxies here):
//   /book/<slug-or-bot-id>   booking page          /book/m/<token>   manage (reschedule / cancel)
//   /book/a/<token>          owner approve/decline /book/ics/<token> calendar file
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { bots, db } from '../../db/index.js';
import { resolvePublicBot } from '../routes/public.js';
import { getBookingByManageToken } from '../service.js';
import { buildIcs } from '../notify/ics.js';
import { brandFor, manageUrl } from '../notify/notifier.js';
import { getSettings } from '../core.js';
import { ACTION_JS, BOOK_JS, MANAGE_JS } from './scripts.js';
import { COMMON_JS, CSS } from './assets.js';

const router = new Hono();

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function doc(opts: { title: string; boot: Record<string, unknown>; script: string; noindex: boolean }): string {
  // `<` is escaped so injected JSON can never close the script tag.
  const boot = JSON.stringify(opts.boot).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">${opts.noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}
<title>${esc(opts.title)}</title><style>${CSS}</style></head>
<body><div id="app"></div><script id="boot" type="application/json">${boot}</script><script>${COMMON_JS}\n${opts.script}</script></body></html>`;
}

const ok = (html: string, frameable: boolean) => new Response(html, {
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(frameable ? {} : { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" }),
    'Referrer-Policy': 'no-referrer',
  },
});

router.get('/m/:token', (c) => ok(doc({ title: 'Your appointment', boot: { token: c.req.param('token') }, script: MANAGE_JS, noindex: true }), false));
router.get('/a/:token', (c) => ok(doc({ title: 'Booking request', boot: { token: c.req.param('token') }, script: ACTION_JS, noindex: true }), false));

router.get('/ics/:token', async (c) => {
  const booking = await getBookingByManageToken(c.req.param('token'));
  if (!booking) return c.text('Not found', 404);
  const [bot] = await db.select().from(bots).where(eq(bots.id, booking.botId)).limit(1);
  const settings = bot ? await getSettings(bot.id) : undefined;
  if (!bot || !settings) return c.text('Not found', 404);
  const brand = brandFor(bot, settings);
  const loc = booking.locationSnapshot ?? {};
  const body = buildIcs([{
    uid: booking.icsUid, sequence: booking.icsSequence, start: booking.startsAt, end: booking.endsAt,
    summary: `${booking.typeName ?? 'Appointment'} with ${brand.name}`,
    description: `Reschedule or cancel: ${manageUrl(booking.id)}`,
    location: loc.type === 'in_person' || loc.type === 'link' ? loc.value ?? undefined : undefined,
    status: booking.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED', alarmMinutes: 30,
  }], { method: booking.status === 'cancelled' ? 'CANCEL' : 'PUBLISH' });
  return new Response(body, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="appointment.ics"', 'Cache-Control': 'no-store' } });
});

// Keep last: any other single segment is a booking-page slug / bot id.
router.get('/:ref', async (c) => {
  const found = await resolvePublicBot(c.req.param('ref'));
  if (!found) return ok(doc({ title: 'Booking', boot: { ref: 'none' }, script: "fail('This booking page is not available.');", noindex: true }), false);
  const brand = brandFor(found.bot, found.settings);
  return ok(doc({ title: `Book with ${brand.name}`, boot: { ref: c.req.param('ref') }, script: BOOK_JS, noindex: false }), true);
});

export default router;
