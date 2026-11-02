// Public booking API — no login. Used by the standalone booking page, the manage/cancel page and the
// widget's "more times" browser. Every route resolves the bot, requires Bookings to be enabled for it
// (and allowed by the plan), and is rate limited where it writes.
import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { Hono } from 'hono';
import { z } from 'zod';
import { bots, db } from '../../db/index.js';
import { jsonBody } from '../../lib/validation.js';
import { tenantHasBooking } from '../entitlements.js';
import { BookingError, getSettings, isBookingReady, listActiveTypes, type Booking, type BookingSettings, type MeetingType } from '../core.js';
import { bookings, bookingSettings } from '../schema.js';
import {
  approveBooking, cancelBooking, confirmBooking, declineBooking, getBookingByManageToken, holdSlot, listSlots, rescheduleBooking,
} from '../service.js';
import { allow, clientIp } from '../rate-limit.js';
import { googleCalendarUrl, outlookCalendarUrl } from '../notify/calendar-links.js';
import { bookBase, brandFor, manageUrl } from '../notify/notifier.js';
import { formatDateTime, formatDay, formatTime, safeTimezone, zoneAbbreviation, type TimeFormat } from '../time.js';
import { signManageToken, verifyActionToken } from '../tokens.js';

const router = new Hono();
type BotRow = typeof bots.$inferSelect;

const err = (c: { json: (b: unknown, s?: number) => Response }, e: unknown) => {
  if (e instanceof BookingError) return c.json({ error: e.message, code: e.code }, e.status);
  throw e;
};

/** Resolve by bot id or booking-page slug, and require the feature to be on. */
export async function resolvePublicBot(ref: string): Promise<{ bot: BotRow; settings: BookingSettings } | null> {
  const isId = /^[0-9a-f-]{36}$/i.test(ref);
  let botId = ref;
  if (!isId) {
    const [row] = await db.select({ botId: bookingSettings.botId }).from(bookingSettings).where(eq(bookingSettings.pageSlug, ref.toLowerCase())).limit(1);
    if (!row) return null;
    botId = row.botId;
  }
  const [bot] = await db.select().from(bots).where(and(eq(bots.id, botId), eq(bots.status, 'active'))).limit(1);
  if (!bot) return null;
  const settings = await getSettings(bot.id);
  if (!settings?.enabled || !(await tenantHasBooking(bot.tenantId)) || !(await isBookingReady(settings))) return null;
  return { bot, settings };
}

const fmtOf = (s: BookingSettings): TimeFormat => (s.timeFormat === '24h' ? '24h' : '12h');

export function dayGroups(slots: Array<{ start: Date }>, tz: string, f: TimeFormat) {
  const days = new Map<string, { date: string; dayLabel: string; slots: Array<{ start: string; timeLabel: string }> }>();
  for (const s of slots) {
    const date = DateTime.fromJSDate(s.start, { zone: tz }).toISODate()!;
    const day = days.get(date) ?? days.set(date, { date, dayLabel: formatDay(s.start, tz), slots: [] }).get(date)!;
    day.slots.push({ start: s.start.toISOString(), timeLabel: formatTime(s.start, tz, f) });
  }
  return [...days.values()];
}

function publicType(t: MeetingType) {
  return {
    id: t.id, name: t.name, description: t.description, durationMin: t.durationMin, priceText: t.priceText, locationType: t.locationType,
    needsApproval: t.confirmation === 'approval',
    questions: t.questions.map((q) => ({ id: q.id, label: q.label, type: q.type, required: q.required, options: q.options })),
  };
}

function summary(b: Booking, tz: string, f: TimeFormat, type?: MeetingType | null, brandName?: string) {
  const title = `${b.typeName ?? 'Appointment'}${brandName ? ` with ${brandName}` : ''}`;
  const where = type ? (type.locationType === 'link' ? type.locationValue : type.locationType === 'phone' ? `Phone call${type.locationValue ? ` · ${type.locationValue}` : ''}` : type.locationType === 'in_person' ? type.locationValue : null) : null;
  const cal = { title, start: b.startsAt, end: b.endsAt, location: where ?? undefined };
  const token = signManageToken(b.id);
  return {
    id: b.id, status: b.status, typeName: b.typeName, name: b.visitorName, email: b.visitorEmail,
    start: b.startsAt.toISOString(), end: b.endsAt.toISOString(), when: formatDateTime(b.startsAt, tz, f), timeLabel: `${formatTime(b.startsAt, tz, f)} – ${formatTime(b.endsAt, tz, f)}`,
    dayLabel: formatDay(b.startsAt, tz), tzLabel: zoneAbbreviation(b.startsAt, tz), timezone: tz, durationMin: Math.round((b.endsAt.getTime() - b.startsAt.getTime()) / 60_000), where,
    manageUrl: manageUrl(b.id), googleUrl: googleCalendarUrl(cal), outlookUrl: outlookCalendarUrl(cal), icsUrl: `${bookBase()}/ics/${token}`,
  };
}

// ─── Booking page data ──────────────────────────────────────────────────────────

router.get('/:ref/info', async (c) => {
  const found = await resolvePublicBot(c.req.param('ref'));
  if (!found) return c.json({ error: 'Booking is not available.' }, 404);
  const { bot, settings } = found;
  const brand = brandFor(bot, settings);
  return c.json({
    botId: bot.id,
    business: { name: brand.name, logoUrl: brand.logoUrl, accent: brand.accent },
    term: settings.term, timezone: settings.timezone, timeFormat: settings.timeFormat, requirePhone: settings.requirePhone,
    paused: settings.paused, pauseMessage: settings.pauseMessage,
    types: (await listActiveTypes(bot.id)).map(publicType),
  });
});

router.get('/:ref/availability', async (c) => {
  const found = await resolvePublicBot(c.req.param('ref'));
  if (!found) return c.json({ error: 'Booking is not available.' }, 404);
  const { bot, settings } = found;
  const typeId = c.req.query('typeId') ?? '';
  const tz = safeTimezone(c.req.query('tz'), safeTimezone(settings.timezone));
  const fromDay = DateTime.fromISO(c.req.query('from') ?? '', { zone: tz });
  const days = Math.min(Math.max(Number.parseInt(c.req.query('days') ?? '14', 10) || 14, 1), 31);
  const now = new Date();
  const from = fromDay.isValid && fromDay.startOf('day').toJSDate() > now ? fromDay.startOf('day').toJSDate() : now;
  const to = new Date(from.getTime() + days * 86400_000);
  try {
    const { slots } = await listSlots({ botId: bot.id, typeId, from, to, zone: tz });
    const groups = dayGroups(slots, tz, fmtOf(settings));
    return c.json({ timezone: tz, tzLabel: slots[0] ? zoneAbbreviation(slots[0].start, tz) : '', days: groups, nextFrom: DateTime.fromJSDate(to, { zone: tz }).toISODate() });
  } catch (e) { return err(c, e); }
});

router.post('/:ref/hold', jsonBody(z.object({ typeId: z.string().uuid(), start: z.string().datetime({ offset: true }), tz: z.string().max(64).optional() })), async (c) => {
  if (!allow(`hold:${clientIp((h) => c.req.header(h))}`, 20, 10 * 60_000)) return c.json({ error: 'Too many attempts. Please wait a few minutes.' }, 429);
  const found = await resolvePublicBot(c.req.param('ref'));
  if (!found) return c.json({ error: 'Booking is not available.' }, 404);
  const b = c.req.valid('json');
  try {
    const hold = await holdSlot({ botId: found.bot.id, typeId: b.typeId, start: new Date(b.start), visitorTz: safeTimezone(b.tz), source: 'page' });
    return c.json({ holdId: hold.id, expiresAt: hold.holdExpiresAt });
  } catch (e) { return err(c, e); }
});

router.post('/:ref/confirm', jsonBody(z.object({
  holdId: z.string().uuid(), name: z.string().min(1).max(120), email: z.string().email().max(200), phone: z.string().max(40).nullable().optional(),
  answers: z.record(z.string().max(1000)).optional(),
})), async (c) => {
  if (!allow(`confirm:${clientIp((h) => c.req.header(h))}`, 10, 10 * 60_000)) return c.json({ error: 'Too many attempts. Please wait a few minutes.' }, 429);
  const found = await resolvePublicBot(c.req.param('ref'));
  if (!found) return c.json({ error: 'Booking is not available.' }, 404);
  const b = c.req.valid('json');
  try {
    const { booking } = await confirmBooking({ botId: found.bot.id, holdId: b.holdId, name: b.name, email: b.email, phone: b.phone, answers: b.answers, actor: 'visitor' });
    const types = await listActiveTypes(found.bot.id);
    const tz = safeTimezone(booking.visitorTz, safeTimezone(found.settings.timezone));
    return c.json({ booking: summary(booking, tz, fmtOf(found.settings), types.find((t) => t.id === booking.meetingTypeId), brandFor(found.bot, found.settings).name) }, 201);
  } catch (e) { return err(c, e); }
});

// ─── Manage a booking (signed link from the email) ──────────────────────────────

async function loadManaged(token: string) {
  const booking = await getBookingByManageToken(token);
  if (!booking) return null;
  const [bot] = await db.select().from(bots).where(eq(bots.id, booking.botId)).limit(1);
  const settings = bot ? await getSettings(bot.id) : undefined;
  if (!bot || !settings) return null;
  const type = (await listActiveTypes(bot.id)).find((t) => t.id === booking.meetingTypeId) ?? null;
  return { booking, bot, settings, type };
}

router.get('/manage/:token', async (c) => {
  const m = await loadManaged(c.req.param('token'));
  if (!m) return c.json({ error: 'This link is not valid.' }, 404);
  const tz = safeTimezone(c.req.query('tz'), safeTimezone(m.booking.visitorTz, safeTimezone(m.settings.timezone)));
  const brand = brandFor(m.bot, m.settings);
  const upcoming = (m.booking.status === 'confirmed' || m.booking.status === 'pending') && m.booking.endsAt > new Date();
  return c.json({
    business: { name: brand.name, logoUrl: brand.logoUrl, accent: brand.accent },
    booking: summary(m.booking, tz, fmtOf(m.settings), m.type, brand.name),
    canChange: upcoming, canReschedule: upcoming && !!m.type, timezone: tz,
  });
});

router.get('/manage/:token/availability', async (c) => {
  const m = await loadManaged(c.req.param('token'));
  if (!m || !m.type) return c.json({ error: 'This link is not valid.' }, 404);
  const tz = safeTimezone(c.req.query('tz'), safeTimezone(m.booking.visitorTz, safeTimezone(m.settings.timezone)));
  const fromDay = DateTime.fromISO(c.req.query('from') ?? '', { zone: tz });
  const now = new Date();
  const from = fromDay.isValid && fromDay.startOf('day').toJSDate() > now ? fromDay.startOf('day').toJSDate() : now;
  const to = new Date(from.getTime() + 14 * 86400_000);
  try {
    const { slots } = await listSlots({ botId: m.bot.id, typeId: m.type.id, from, to, zone: tz });
    return c.json({ timezone: tz, tzLabel: slots[0] ? zoneAbbreviation(slots[0].start, tz) : '', days: dayGroups(slots, tz, fmtOf(m.settings)), nextFrom: DateTime.fromJSDate(to, { zone: tz }).toISODate() });
  } catch (e) { return err(c, e); }
});

router.post('/manage/:token/reschedule', jsonBody(z.object({ start: z.string().datetime({ offset: true }) })), async (c) => {
  if (!allow(`manage:${clientIp((h) => c.req.header(h))}`, 20, 10 * 60_000)) return c.json({ error: 'Too many attempts. Please wait a few minutes.' }, 429);
  const m = await loadManaged(c.req.param('token'));
  if (!m) return c.json({ error: 'This link is not valid.' }, 404);
  try {
    const updated = await rescheduleBooking(m.bot.id, m.booking.id, new Date(c.req.valid('json').start), { actor: 'visitor' });
    const tz = safeTimezone(updated.visitorTz, safeTimezone(m.settings.timezone));
    return c.json({ booking: summary(updated, tz, fmtOf(m.settings), m.type, brandFor(m.bot, m.settings).name) });
  } catch (e) { return err(c, e); }
});

router.post('/manage/:token/cancel', jsonBody(z.object({ reason: z.string().max(300).nullable().optional() })), async (c) => {
  if (!allow(`manage:${clientIp((h) => c.req.header(h))}`, 20, 10 * 60_000)) return c.json({ error: 'Too many attempts. Please wait a few minutes.' }, 429);
  const m = await loadManaged(c.req.param('token'));
  if (!m) return c.json({ error: 'This link is not valid.' }, 404);
  try {
    const updated = await cancelBooking(m.bot.id, m.booking.id, { actor: 'visitor', reason: c.req.valid('json').reason });
    const tz = safeTimezone(updated.visitorTz, safeTimezone(m.settings.timezone));
    return c.json({ booking: summary(updated, tz, fmtOf(m.settings), m.type, brandFor(m.bot, m.settings).name) });
  } catch (e) { return err(c, e); }
});

// ─── Owner one-tap approve / decline (signed link from the email) ───────────────

async function loadAction(token: string) {
  const parsed = verifyActionToken(token);
  if (!parsed) return null;
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, parsed.bookingId)).limit(1);
  if (!booking) return null;
  const [bot] = await db.select().from(bots).where(eq(bots.id, booking.botId)).limit(1);
  const settings = bot ? await getSettings(bot.id) : undefined;
  return bot && settings ? { parsed, booking, bot, settings } : null;
}

/** GET only describes the request — it never changes state, because email scanners prefetch links. */
router.get('/action/:token', async (c) => {
  const a = await loadAction(c.req.param('token'));
  if (!a) return c.json({ error: 'This link has expired or is not valid.' }, 404);
  const brand = brandFor(a.bot, a.settings);
  const tz = safeTimezone(a.settings.timezone);
  return c.json({ action: a.parsed.action, business: { name: brand.name, logoUrl: brand.logoUrl, accent: brand.accent }, booking: summary(a.booking, tz, fmtOf(a.settings), null, brand.name), pending: a.booking.status === 'pending' });
});

router.post('/action/:token', jsonBody(z.object({ reason: z.string().max(300).nullable().optional() })), async (c) => {
  const a = await loadAction(c.req.param('token'));
  if (!a) return c.json({ error: 'This link has expired or is not valid.' }, 404);
  try {
    const updated = a.parsed.action === 'approve'
      ? await approveBooking(a.bot.id, a.booking.id, { actor: 'owner' })
      : await declineBooking(a.bot.id, a.booking.id, { actor: 'owner', reason: c.req.valid('json').reason });
    return c.json({ status: updated.status });
  } catch (e) { return err(c, e); }
});

export default router;
