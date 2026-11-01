// Owner routes: overview, appointments, calendar, people, exports.
import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { jsonBody } from '../../lib/validation.js';
import { bookings, bookingNotes } from '../schema.js';
import {
  BookingError, ensureSettings, type Booking, type BookingSettings,
} from '../core.js';
import {
  addNote, approveBooking, cancelBooking, createManualBooking, declineBooking, listSlots, markOutcome, rescheduleBooking,
  setBookingTags, setPersonTags,
} from '../service.js';
import {
  bookingConditions, bookingsInRange, conversationPreview, deletePerson, getBookingDetail, getOverview, getPerson,
  listBookings, listPeople, viewCounts, type BookingFilter, type BookingView, type PeopleSegment,
} from '../queries.js';
import { enqueueEmail } from '../jobs.js';
import { agendaPdf, bookingSheetPdf, bookingsCsv, bookingsIcs, bookingsPdf, bookingsXlsx, toCsv, toXlsx, type ExportStyle } from '../exports.js';
import { brandFor, dashboardBookingUrl } from '../notify/notifier.js';
import { handleError, intParam, parseDate, uuidParam, type BookingOwnerEnv } from './guard.js';
import { safeTimezone } from '../time.js';

const router = new Hono<BookingOwnerEnv>();

const VIEWS: BookingView[] = ['upcoming', 'today', 'pending', 'past', 'cancelled', 'no_show', 'all'];

function filterFrom(q: Record<string, string | undefined>): BookingFilter {
  return {
    view: VIEWS.includes(q.view as BookingView) ? (q.view as BookingView) : 'all',
    q: q.q?.slice(0, 100),
    from: parseDate(q.from), to: parseDate(q.to),
    typeId: uuidParam(q.typeId) ? q.typeId : undefined,
    status: q.status ? q.status.split(',').slice(0, 8) : undefined,
    source: q.source, tag: q.tag?.slice(0, 40), personId: uuidParam(q.personId) ? q.personId : undefined,
    sort: (['start_asc', 'start_desc', 'created_desc'] as const).find((s) => s === q.sort),
    page: intParam(q.page, 1, 1, 100_000), pageSize: intParam(q.pageSize, 25, 1, 200),
  };
}

async function styleFor(botId: string, settings: BookingSettings, bot: Parameters<typeof brandFor>[0]): Promise<ExportStyle> {
  const brand = brandFor(bot, settings);
  return { tz: safeTimezone(settings.timezone), timeFormat: settings.timeFormat === '24h' ? '24h' : '12h', businessName: brand.name, accent: /^#[0-9a-f]{6}$/i.test(brand.accent) ? brand.accent : '#4F46E5' };
}

const file = (c: { header: (k: string, v: string) => void }, name: string, type: string) => {
  c.header('Content-Type', type);
  c.header('Content-Disposition', `attachment; filename="${name}"`);
  c.header('Cache-Control', 'no-store');
};
const stamp = () => DateTime.now().toFormat('yyyy-LL-dd');

// ─── Overview, counts, calendar ─────────────────────────────────────────────────

router.get('/overview', async (c) => {
  const bot = c.get('bot');
  const settings = await ensureSettings(bot);
  return c.json({ overview: await getOverview(bot.id, settings, intParam(c.req.query('days'), 30, 7, 365)), timezone: settings.timezone });
});

router.get('/bookings/counts', async (c) => {
  const bot = c.get('bot');
  return c.json({ counts: await viewCounts(bot.id, await ensureSettings(bot)) });
});

router.get('/bookings/calendar', async (c) => {
  const bot = c.get('bot');
  const from = parseDate(c.req.query('from')); const to = parseDate(c.req.query('to'));
  if (!from || !to || to <= from || to.getTime() - from.getTime() > 100 * 86400_000) return c.json({ error: 'Provide a valid from/to range (max 100 days).' }, 400);
  return c.json({ bookings: await bookingsInRange(bot.id, from, to) });
});

/** Open slots for picking a time in the dashboard (manual booking, reschedule). */
router.get('/slots', async (c) => {
  const bot = c.get('bot');
  const typeId = c.req.query('typeId') ?? '';
  if (!uuidParam(typeId)) return c.json({ error: 'typeId required' }, 400);
  const from = parseDate(c.req.query('from')); const to = parseDate(c.req.query('to'));
  try {
    const { slots, settings } = await listSlots({ botId: bot.id, typeId, from, to: to ?? (from ? new Date(from.getTime() + 14 * 86400_000) : undefined) });
    return c.json({ timezone: settings.timezone, slots: slots.slice(0, 600).map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })) });
  } catch (err) { return handleError(c, err); }
});

// ─── Appointments ───────────────────────────────────────────────────────────────

router.get('/bookings', async (c) => {
  const bot = c.get('bot');
  return c.json(await listBookings(bot.id, await ensureSettings(bot), filterFrom(c.req.query())));
});

router.post('/bookings', jsonBody(z.object({
  typeId: z.string().uuid(), start: z.string().datetime({ offset: true }), name: z.string().min(1).max(120), email: z.string().email().max(200),
  phone: z.string().max(40).nullable().optional(), answers: z.record(z.string()).optional(), notify: z.boolean().optional(), ignoreHours: z.boolean().optional(),
})), async (c) => {
  const bot = c.get('bot'); const b = c.req.valid('json');
  try {
    const { booking } = await createManualBooking({
      botId: bot.id, tenantId: bot.tenantId, typeId: b.typeId, start: new Date(b.start), name: b.name, email: b.email, phone: b.phone,
      answers: b.answers, notify: b.notify, ignoreHours: b.ignoreHours, actorUserId: c.get('user').id,
    });
    return c.json({ booking }, 201);
  } catch (err) { return handleError(c, err); }
});

router.get('/bookings/:bid', async (c) => {
  const bot = c.get('bot');
  if (!uuidParam(c.req.param('bid'))) return c.json({ error: 'Not found' }, 404);
  const detail = await getBookingDetail(bot.id, c.req.param('bid'));
  if (!detail) return c.json({ error: 'Not found' }, 404);
  const preview = detail.booking.conversationId ? await conversationPreview(detail.booking.conversationId) : [];
  return c.json({ ...detail, conversationPreview: preview, questions: Object.fromEntries((detail.type?.questions ?? []).map((q) => [q.id, q.label])) });
});

const actor = (c: { get: (k: 'user') => { id: string } }) => ({ actor: 'owner' as const, actorUserId: c.get('user').id });

router.post('/bookings/:bid/reschedule', jsonBody(z.object({ start: z.string().datetime({ offset: true }), notify: z.boolean().optional(), ignoreHours: z.boolean().optional(), reason: z.string().max(300).nullable().optional() })), async (c) => {
  const b = c.req.valid('json');
  try { return c.json({ booking: await rescheduleBooking(c.get('bot').id, c.req.param('bid'), new Date(b.start), { ...actor(c), notify: b.notify, reason: b.reason, ignoreHours: b.ignoreHours }) }); }
  catch (err) { return handleError(c, err); }
});

router.post('/bookings/:bid/cancel', jsonBody(z.object({ reason: z.string().max(300).nullable().optional(), notify: z.boolean().optional() })), async (c) => {
  const b = c.req.valid('json');
  try { return c.json({ booking: await cancelBooking(c.get('bot').id, c.req.param('bid'), { ...actor(c), reason: b.reason, notify: b.notify }) }); }
  catch (err) { return handleError(c, err); }
});

router.post('/bookings/:bid/approve', async (c) => {
  try { return c.json({ booking: await approveBooking(c.get('bot').id, c.req.param('bid'), actor(c)) }); } catch (err) { return handleError(c, err); }
});

router.post('/bookings/:bid/decline', jsonBody(z.object({ reason: z.string().max(300).nullable().optional() })), async (c) => {
  try { return c.json({ booking: await declineBooking(c.get('bot').id, c.req.param('bid'), { ...actor(c), reason: c.req.valid('json').reason }) }); } catch (err) { return handleError(c, err); }
});

router.post('/bookings/:bid/outcome', jsonBody(z.object({ outcome: z.enum(['completed', 'no_show', 'confirmed']), note: z.string().max(500).nullable().optional() })), async (c) => {
  const b = c.req.valid('json');
  try { return c.json({ booking: await markOutcome(c.get('bot').id, c.req.param('bid'), b.outcome, { actorUserId: c.get('user').id, note: b.note }) }); } catch (err) { return handleError(c, err); }
});

router.post('/bookings/:bid/notes', jsonBody(z.object({ body: z.string().min(1).max(4000) })), async (c) => {
  const user = c.get('user');
  try { return c.json({ note: await addNote(c.get('bot').id, { bookingId: c.req.param('bid'), body: c.req.valid('json').body, userId: user.id, userName: user.name }) }, 201); }
  catch (err) { return handleError(c, err); }
});

router.delete('/notes/:noteId', async (c) => {
  if (!uuidParam(c.req.param('noteId'))) return c.json({ error: 'Not found' }, 404);
  await db.delete(bookingNotes).where(and(eq(bookingNotes.id, c.req.param('noteId')), eq(bookingNotes.botId, c.get('bot').id)));
  return c.json({ success: true });
});

router.put('/bookings/:bid/tags', jsonBody(z.object({ tags: z.array(z.string().max(30)).max(12) })), async (c) => {
  try { return c.json(await setBookingTags(c.get('bot').id, c.req.param('bid'), c.req.valid('json').tags)); } catch (err) { return handleError(c, err); }
});

const RESENDABLE = ['visitor.confirmed', 'visitor.reminder_24h', 'visitor.reminder_1h', 'visitor.rescheduled', 'visitor.cancelled'] as const;
router.post('/bookings/:bid/resend', jsonBody(z.object({ template: z.enum(RESENDABLE).default('visitor.confirmed') })), async (c) => {
  const bot = c.get('bot');
  const [b] = await db.select({ id: bookings.id }).from(bookings).where(and(eq(bookings.id, c.req.param('bid')), eq(bookings.botId, bot.id))).limit(1);
  if (!b) return c.json({ error: 'Not found' }, 404);
  await enqueueEmail(db, { template: c.req.valid('json').template, bookingId: b.id, botId: bot.id });
  return c.json({ success: true });
});

router.post('/bookings/bulk', jsonBody(z.object({
  ids: z.array(z.string().uuid()).min(1).max(100), action: z.enum(['complete', 'no_show', 'cancel', 'tag']),
  reason: z.string().max(300).nullable().optional(), tag: z.string().max(30).optional(), notify: z.boolean().optional(),
})), async (c) => {
  const bot = c.get('bot'); const b = c.req.valid('json');
  let done = 0; const failed: Array<{ id: string; error: string }> = [];
  for (const id of b.ids) {
    try {
      if (b.action === 'complete') await markOutcome(bot.id, id, 'completed', { actorUserId: c.get('user').id });
      else if (b.action === 'no_show') await markOutcome(bot.id, id, 'no_show', { actorUserId: c.get('user').id });
      else if (b.action === 'cancel') await cancelBooking(bot.id, id, { ...actor(c), reason: b.reason, notify: b.notify });
      else if (b.action === 'tag' && b.tag) {
        const [row] = await db.select({ tags: bookings.tags }).from(bookings).where(and(eq(bookings.id, id), eq(bookings.botId, bot.id))).limit(1);
        if (row) await setBookingTags(bot.id, id, [...row.tags, b.tag]);
      }
      done++;
    } catch (err) { failed.push({ id, error: err instanceof BookingError ? err.message : 'Failed' }); }
  }
  return c.json({ done, failed });
});

// ─── People ─────────────────────────────────────────────────────────────────────

router.get('/people', async (c) => {
  const q = c.req.query();
  return c.json(await listPeople(c.get('bot').id, {
    q: q.q?.slice(0, 100), tag: q.tag?.slice(0, 40),
    segment: (['new', 'returning', 'upcoming', 'no_show', 'leads'] as PeopleSegment[]).find((s) => s === q.segment),
    sort: (['recent', 'name', 'bookings'] as const).find((s) => s === q.sort),
    page: intParam(q.page, 1, 1, 100_000), pageSize: intParam(q.pageSize, 25, 1, 200),
  }));
});

router.get('/people/:pid', async (c) => {
  if (!uuidParam(c.req.param('pid'))) return c.json({ error: 'Not found' }, 404);
  const detail = await getPerson(c.get('bot').id, c.req.param('pid'));
  return detail ? c.json(detail) : c.json({ error: 'Not found' }, 404);
});

router.put('/people/:pid/tags', jsonBody(z.object({ tags: z.array(z.string().max(30)).max(12) })), async (c) => {
  try { return c.json(await setPersonTags(c.get('bot').id, c.req.param('pid'), c.req.valid('json').tags)); } catch (err) { return handleError(c, err); }
});

router.post('/people/:pid/notes', jsonBody(z.object({ body: z.string().min(1).max(4000) })), async (c) => {
  const user = c.get('user');
  try { return c.json({ note: await addNote(c.get('bot').id, { personId: c.req.param('pid'), body: c.req.valid('json').body, userId: user.id, userName: user.name }) }, 201); }
  catch (err) { return handleError(c, err); }
});

router.delete('/people/:pid', async (c) => {
  if (!uuidParam(c.req.param('pid'))) return c.json({ error: 'Not found' }, 404);
  const ok = await deletePerson(c.get('bot').id, c.req.param('pid'), { conversations: c.req.query('conversations') === '1' });
  return ok ? c.json({ success: true }) : c.json({ error: 'Not found' }, 404);
});

// ─── Exports ────────────────────────────────────────────────────────────────────

async function exportRows(botId: string, settings: BookingSettings, f: BookingFilter): Promise<Booking[]> {
  const { where, order } = bookingConditions(botId, settings, f);
  return db.select().from(bookings).where(where).orderBy(...order).limit(10_000);
}

router.get('/export', async (c) => {
  const bot = c.get('bot');
  const settings = await ensureSettings(bot);
  const style = await styleFor(bot.id, settings, bot);
  const f = filterFrom(c.req.query());
  const rows = await exportRows(bot.id, settings, f);
  const format = c.req.query('format') ?? 'csv';
  const base = `appointments-${stamp()}`;

  if (format === 'xlsx') { file(c, `${base}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); return c.body(new Uint8Array(await bookingsXlsx(rows, style))); }
  if (format === 'pdf') {
    file(c, `${base}.pdf`, 'application/pdf');
    const subtitle = [f.view && f.view !== 'all' ? `View: ${f.view.replace('_', '-')}` : null, f.q ? `Search: "${f.q}"` : null, f.from ? `From ${stamp()}` : null].filter(Boolean).join('  ·  ');
    return c.body(new Uint8Array(await bookingsPdf(rows, style, { title: 'Appointments', subtitle })));
  }
  if (format === 'ics') {
    file(c, `${base}.ics`, 'text/calendar; charset=utf-8');
    return c.body(bookingsIcs(rows, { calendarName: `${style.businessName} appointments`, organizerEmail: '', businessName: style.businessName, dashboardUrl: (b) => dashboardBookingUrl(b.botId, b.id) }));
  }
  file(c, `${base}.csv`, 'text/csv; charset=utf-8');
  return c.body(new Uint8Array(bookingsCsv(rows, style)));
});

router.get('/export/people', async (c) => {
  const bot = c.get('bot');
  const settings = await ensureSettings(bot);
  const style = await styleFor(bot.id, settings, bot);
  const { rows } = await listPeople(bot.id, { pageSize: 200, sort: 'name' });
  let all = rows;
  for (let page = 2; all.length < 5000; page++) {
    const next = (await listPeople(bot.id, { pageSize: 200, sort: 'name', page })).rows;
    if (!next.length) break;
    all = all.concat(next);
  }
  const headers = [{ header: 'Name', width: 22 }, { header: 'Email', width: 30 }, { header: 'Phone', width: 16 }, { header: 'Bookings', width: 10 }, { header: 'No-shows', width: 10 }, { header: 'Conversations', width: 14 }, { header: 'First seen', width: 17 }, { header: 'Last seen', width: 17 }, { header: 'Tags', width: 20 }, { header: 'Source', width: 12 }];
  const fmt = (v: unknown) => (v ? DateTime.fromJSDate(new Date(v as string), { zone: style.tz }).toFormat('yyyy-LL-dd HH:mm') : '');
  const data = all.map((p) => [p.name ?? '', p.email ?? '', p.phone ?? '', p.bookingsCount, p.noShows, p.conversationsCount, fmt(p.firstSeenAt), fmt(p.lastSeenAt), ((p.tags as string[]) ?? []).join(', '), p.source]);
  if (c.req.query('format') === 'xlsx') { file(c, `people-${stamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); return c.body(new Uint8Array(await toXlsx('People', headers, data, style.accent))); }
  file(c, `people-${stamp()}.csv`, 'text/csv; charset=utf-8');
  return c.body(new Uint8Array(toCsv(headers.map((h) => h.header), data)));
});

router.get('/export/emails', async (c) => {
  // Just the distinct visitor emails — the common "export my contacts" ask.
  const bot = c.get('bot');
  const style = await styleFor(bot.id, await ensureSettings(bot), bot);
  const { rows } = await listPeople(bot.id, { pageSize: 200, sort: 'name' });
  const headers = [{ header: 'Email', width: 32 }, { header: 'Name', width: 22 }, { header: 'Phone', width: 16 }];
  const data = rows.filter((p) => p.email).map((p) => [p.email, p.name ?? '', p.phone ?? '']);
  if (c.req.query('format') === 'xlsx') { file(c, `emails-${stamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); return c.body(new Uint8Array(await toXlsx('Emails', headers, data, style.accent))); }
  file(c, `emails-${stamp()}.csv`, 'text/csv; charset=utf-8');
  return c.body(new Uint8Array(toCsv(headers.map((h) => h.header), data)));
});

router.get('/export/agenda', async (c) => {
  const bot = c.get('bot');
  const settings = await ensureSettings(bot);
  const style = await styleFor(bot.id, settings, bot);
  const day = c.req.query('date')?.match(/^\d{4}-\d{2}-\d{2}$/) ? c.req.query('date')! : DateTime.now().setZone(style.tz).toISODate()!;
  const start = DateTime.fromISO(day, { zone: style.tz }).startOf('day');
  const list = (await bookingsInRange(bot.id, start.toJSDate(), start.plus({ days: 1 }).toJSDate())).filter((b) => ['confirmed', 'pending', 'completed', 'no_show'].includes(b.status));
  file(c, `agenda-${day}.pdf`, 'application/pdf');
  return c.body(new Uint8Array(await agendaPdf(list, style, start.toJSDate())));
});

router.get('/bookings/:bid/sheet.pdf', async (c) => {
  const bot = c.get('bot');
  if (!uuidParam(c.req.param('bid'))) return c.json({ error: 'Not found' }, 404);
  const detail = await getBookingDetail(bot.id, c.req.param('bid'));
  if (!detail) return c.json({ error: 'Not found' }, 404);
  const style = await styleFor(bot.id, await ensureSettings(bot), bot);
  file(c, `booking-${detail.booking.id.slice(0, 8)}.pdf`, 'application/pdf');
  return c.body(new Uint8Array(await bookingSheetPdf(detail.booking, style, {
    questions: new Map((detail.type?.questions ?? []).map((q) => [q.id, q.label])),
    notes: detail.notes.map((n) => ({ body: n.body, at: n.createdAt, by: n.authorName })),
  })));
});

export default router;
