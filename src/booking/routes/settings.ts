// Owner routes: settings, meeting types, availability, sharing, calendar feed, email templates.
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { bots, db } from '../../db/index.js';
import { jsonBody } from '../../lib/validation.js';
import { bookBase, sampleContext, sendTestEmail } from '../notify/notifier.js';
import { renderEmail, TEMPLATE_AUDIENCE, isTemplateName, type TemplateName } from '../notify/templates.js';
import { ensureSettings, getMeetingType } from '../core.js';
import { signFeedToken } from '../tokens.js';
import { isValidTimezone } from '../time.js';
import {
  availabilityBlocks, availabilityOverrides, availabilityRules, bookings, bookingSettings, emailLog, meetingTypes,
} from '../schema.js';
import { intParam, uuidParam, type BookingOwnerEnv } from './guard.js';

const router = new Hono<BookingOwnerEnv>();

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const email = z.string().email().max(200);

// ─── Settings ───────────────────────────────────────────────────────────────────

const notifySchema = z.object({
  recipients: z.array(email).max(10).optional(),
  ownerNewBooking: z.boolean().optional(), ownerChanges: z.boolean().optional(),
  visitorConfirmation: z.boolean().optional(), visitorChanges: z.boolean().optional(),
  reminder24h: z.boolean().optional(), reminder1h: z.boolean().optional(),
  followUp: z.boolean().optional(), followUpHours: z.number().int().min(1).max(168).optional(),
  followUpMessage: z.string().max(600).nullable().optional(), reviewUrl: z.string().url().max(500).nullable().optional().or(z.literal('')),
  dailyAgenda: z.boolean().optional(), weeklySummary: z.boolean().optional(),
  confirmationMessage: z.string().max(600).nullable().optional(),
}).strict();

const brandingSchema = z.object({
  logoUrl: z.string().url().max(500).nullable().optional().or(z.literal('')),
  accent: color.nullable().optional().or(z.literal('')),
  senderName: z.string().max(80).nullable().optional(),
  replyTo: email.nullable().optional().or(z.literal('')),
  signOff: z.string().max(300).nullable().optional(),
  footer: z.string().max(300).nullable().optional(),
}).strict();

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  timezone: z.string().refine((t) => isValidTimezone(t), 'Unknown time zone').optional(),
  slotIntervalMin: z.number().int().min(5).max(240).optional(),
  windowDays: z.number().int().min(1).max(365).optional(),
  minNoticeMin: z.number().int().min(0).max(60 * 24 * 60).optional(),
  dailyCap: z.number().int().min(1).max(500).nullable().optional(),
  offerMode: z.enum(['request', 'intent', 'proactive']).optional(),
  term: z.string().min(1).max(40).optional(),
  requirePhone: z.boolean().optional(),
  aiInstructions: z.string().max(2000).nullable().optional(),
  whenFull: z.enum(['contact', 'waitlist', 'phone']).optional(),
  paused: z.boolean().optional(),
  pauseMessage: z.string().max(300).nullable().optional(),
  timeFormat: z.enum(['12h', '24h']).optional(),
  weekStart: z.number().int().min(0).max(6).optional(),
  notify: notifySchema.optional(),
  branding: brandingSchema.optional(),
  pageSlug: z.string().regex(/^[a-z0-9-]{3,40}$/, 'Use 3–40 lowercase letters, numbers or dashes').nullable().optional(),
  onboardingDone: z.boolean().optional(),
});

/** Empty strings from forms mean "unset". */
const clean = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === '' ? null : v])) as T;

router.get('/settings', async (c) => {
  const bot = c.get('bot');
  const settings = await ensureSettings(bot);
  const [{ types }] = await db.select({ types: sql<number>`count(*)::int` }).from(meetingTypes).where(eq(meetingTypes.botId, bot.id));
  const [{ rules }] = await db.select({ rules: sql<number>`count(*)::int` }).from(availabilityRules).where(eq(availabilityRules.botId, bot.id));
  return c.json({ settings, setup: { hasTypes: types > 0, hasHours: rules > 0 }, pageUrl: `${bookBase()}/${settings.pageSlug || bot.id}` });
});

router.put('/settings', jsonBody(settingsSchema), async (c) => {
  const bot = c.get('bot');
  const body = c.req.valid('json');
  const current = await ensureSettings(bot);
  const { onboardingDone, notify, branding, ...rest } = body;

  const update: Partial<typeof bookingSettings.$inferInsert> = { ...rest, updatedAt: new Date() };
  if (notify) update.notify = { ...current.notify, ...clean(notify) } as never;
  if (branding) update.branding = { ...current.branding, ...clean(branding) } as never;
  if (onboardingDone !== undefined) update.onboardingDoneAt = onboardingDone ? new Date() : null;
  try {
    await db.update(bookingSettings).set(update).where(eq(bookingSettings.botId, bot.id));
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return c.json({ error: 'That page address is already taken.' }, 409);
    throw err;
  }
  // The bot list/NewBotModal still reads this flag.
  if (body.enabled !== undefined) await db.update(bots).set({ bookingEnabled: body.enabled }).where(eq(bots.id, bot.id));
  return c.json({ settings: await ensureSettings(bot) });
});

// ─── Meeting types ──────────────────────────────────────────────────────────────

const questionSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(200),
  type: z.enum(['text', 'long_text', 'single_choice', 'multi_choice', 'yes_no', 'phone', 'number', 'date']),
  required: z.boolean(),
  options: z.array(z.string().min(1).max(100)).max(20).optional(),
});

const typeSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(600).nullable().optional(),
  durationMin: z.number().int().min(5).max(480),
  locationType: z.enum(['link', 'phone', 'in_person', 'later']),
  locationValue: z.string().max(500).nullable().optional(),
  priceText: z.string().max(60).nullable().optional(),
  bufferBeforeMin: z.number().int().min(0).max(240).default(0),
  bufferAfterMin: z.number().int().min(0).max(240).default(0),
  minNoticeMin: z.number().int().min(0).max(60 * 24 * 60).nullable().optional(),
  windowDays: z.number().int().min(1).max(365).nullable().optional(),
  maxPerDay: z.number().int().min(1).max(100).nullable().optional(),
  slotIntervalMin: z.number().int().min(5).max(240).nullable().optional(),
  confirmation: z.enum(['instant', 'approval']).default('instant'),
  confirmationMessage: z.string().max(600).nullable().optional(),
  questions: z.array(questionSchema).max(10).default([]),
  active: z.boolean().default(true),
  sort: z.number().int().optional(),
});

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'meeting';

async function uniqueSlug(botId: string, name: string): Promise<string> {
  const base = slugify(name);
  const taken = new Set((await db.select({ s: meetingTypes.slug }).from(meetingTypes).where(eq(meetingTypes.botId, botId))).map((r) => r.s));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

router.get('/types', async (c) => {
  const bot = c.get('bot');
  const rows = await db.select().from(meetingTypes).where(eq(meetingTypes.botId, bot.id)).orderBy(asc(meetingTypes.sort), asc(meetingTypes.createdAt));
  const upcoming = await db.select({ id: bookings.meetingTypeId, n: sql<number>`count(*)::int` }).from(bookings)
    .where(and(eq(bookings.botId, bot.id), inArray(bookings.status, ['confirmed', 'pending']), gte(bookings.startsAt, new Date()))).groupBy(bookings.meetingTypeId);
  const counts = new Map(upcoming.map((u) => [u.id, u.n]));
  return c.json({ types: rows.map((t) => ({ ...t, upcomingBookings: counts.get(t.id) ?? 0 })) });
});

router.post('/types', jsonBody(typeSchema), async (c) => {
  const bot = c.get('bot');
  const body = c.req.valid('json');
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(meetingTypes).where(eq(meetingTypes.botId, bot.id));
  if (n >= 20) return c.json({ error: 'You can have up to 20 meeting types.' }, 400);
  const [row] = await db.insert(meetingTypes).values({ ...body, botId: bot.id, tenantId: bot.tenantId, slug: await uniqueSlug(bot.id, body.name), sort: body.sort ?? n }).returning();
  return c.json({ type: row }, 201);
});

router.put('/types/reorder', jsonBody(z.object({ ids: z.array(z.string().uuid()).max(50) })), async (c) => {
  const bot = c.get('bot');
  const { ids } = c.req.valid('json');
  await db.transaction(async (tx) => {
    for (const [i, id] of ids.entries()) await tx.update(meetingTypes).set({ sort: i }).where(and(eq(meetingTypes.id, id), eq(meetingTypes.botId, bot.id)));
  });
  return c.json({ success: true });
});

router.put('/types/:typeId', jsonBody(typeSchema.partial()), async (c) => {
  const bot = c.get('bot');
  const typeId = c.req.param('typeId');
  if (!uuidParam(typeId) || !(await getMeetingType(bot.id, typeId))) return c.json({ error: 'Not found' }, 404);
  const [row] = await db.update(meetingTypes).set({ ...c.req.valid('json'), updatedAt: new Date() }).where(and(eq(meetingTypes.id, typeId), eq(meetingTypes.botId, bot.id))).returning();
  return c.json({ type: row });
});

router.post('/types/:typeId/duplicate', async (c) => {
  const bot = c.get('bot');
  const existing = uuidParam(c.req.param('typeId')) ? await getMeetingType(bot.id, c.req.param('typeId')) : undefined;
  if (!existing) return c.json({ error: 'Not found' }, 404);
  const { id: _id, createdAt: _c, updatedAt: _u, slug: _s, ...copy } = existing;
  const name = `${existing.name} (copy)`.slice(0, 80);
  const [row] = await db.insert(meetingTypes).values({ ...copy, name, slug: await uniqueSlug(bot.id, name), sort: existing.sort + 1 }).returning();
  return c.json({ type: row }, 201);
});

router.delete('/types/:typeId', async (c) => {
  const bot = c.get('bot');
  const typeId = c.req.param('typeId');
  if (!uuidParam(typeId) || !(await getMeetingType(bot.id, typeId))) return c.json({ error: 'Not found' }, 404);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(bookings)
    .where(and(eq(bookings.meetingTypeId, typeId), inArray(bookings.status, ['confirmed', 'pending']), gte(bookings.startsAt, new Date())));
  if (n > 0) return c.json({ error: `This type has ${n} upcoming booking${n === 1 ? '' : 's'}. Deactivate it instead.`, upcoming: n }, 409);
  await db.delete(meetingTypes).where(and(eq(meetingTypes.id, typeId), eq(meetingTypes.botId, bot.id)));
  return c.json({ success: true });
});

// ─── Availability ───────────────────────────────────────────────────────────────

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const rangeSchema = z.object({ start: hhmm, end: hhmm }).refine((r) => r.end > r.start, 'End must be after start');

router.get('/availability', async (c) => {
  const bot = c.get('bot');
  const [rules, overrides, blocks] = await Promise.all([
    db.select().from(availabilityRules).where(eq(availabilityRules.botId, bot.id)).orderBy(asc(availabilityRules.weekday), asc(availabilityRules.startTime)),
    db.select().from(availabilityOverrides).where(and(eq(availabilityOverrides.botId, bot.id), gte(availabilityOverrides.date, sql`current_date - 1`))).orderBy(asc(availabilityOverrides.date)),
    db.select().from(availabilityBlocks).where(and(eq(availabilityBlocks.botId, bot.id), gte(availabilityBlocks.endsAt, new Date()))).orderBy(asc(availabilityBlocks.startsAt)),
  ]);
  return c.json({
    rules: rules.map((r) => ({ id: r.id, weekday: r.weekday, start: r.startTime.slice(0, 5), end: r.endTime.slice(0, 5) })),
    overrides, blocks,
  });
});

router.put('/availability/rules', jsonBody(z.object({
  rules: z.array(z.object({ weekday: z.number().int().min(1).max(7), start: hhmm, end: hhmm })).max(70),
})), async (c) => {
  const bot = c.get('bot');
  const { rules } = c.req.valid('json');
  for (const r of rules) if (r.end <= r.start) return c.json({ error: 'Each range must end after it starts.' }, 400);
  for (const day of new Set(rules.map((r) => r.weekday))) {
    const list = rules.filter((r) => r.weekday === day).sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < list.length; i++) if (list[i].start < list[i - 1].end) return c.json({ error: 'Time ranges on the same day cannot overlap.' }, 400);
  }
  await db.transaction(async (tx) => {
    await tx.delete(availabilityRules).where(eq(availabilityRules.botId, bot.id));
    if (rules.length) await tx.insert(availabilityRules).values(rules.map((r) => ({ botId: bot.id, tenantId: bot.tenantId, weekday: r.weekday, startTime: r.start, endTime: r.end })));
  });
  return c.json({ success: true });
});

router.post('/availability/overrides', jsonBody(z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), closed: z.boolean(), ranges: z.array(rangeSchema).max(6).default([]), note: z.string().max(120).nullable().optional(),
})), async (c) => {
  const bot = c.get('bot');
  const b = c.req.valid('json');
  const [row] = await db.insert(availabilityOverrides).values({ botId: bot.id, tenantId: bot.tenantId, date: b.date, closed: b.closed, ranges: b.closed ? [] : b.ranges, note: b.note ?? null })
    .onConflictDoUpdate({ target: [availabilityOverrides.botId, availabilityOverrides.date], set: { closed: b.closed, ranges: b.closed ? [] : b.ranges, note: b.note ?? null } }).returning();
  return c.json({ override: row });
});

router.delete('/availability/overrides/:date', async (c) => {
  await db.delete(availabilityOverrides).where(and(eq(availabilityOverrides.botId, c.get('bot').id), eq(availabilityOverrides.date, c.req.param('date'))));
  return c.json({ success: true });
});

router.post('/availability/blocks', jsonBody(z.object({
  startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), reason: z.string().max(120).nullable().optional(),
})), async (c) => {
  const bot = c.get('bot');
  const b = c.req.valid('json');
  const startsAt = new Date(b.startsAt); const endsAt = new Date(b.endsAt);
  if (endsAt <= startsAt) return c.json({ error: 'End must be after start.' }, 400);
  const [row] = await db.insert(availabilityBlocks).values({ botId: bot.id, tenantId: bot.tenantId, startsAt, endsAt, reason: b.reason ?? null, createdBy: c.get('user').id }).returning();
  // Existing bookings aren't cancelled automatically — tell the owner so they can handle them.
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(bookings)
    .where(and(eq(bookings.botId, bot.id), inArray(bookings.status, ['confirmed', 'pending']), sql`${bookings.startsAt} < ${endsAt.toISOString()}::timestamptz AND ${bookings.endsAt} > ${startsAt.toISOString()}::timestamptz`));
  return c.json({ block: row, conflicts: n }, 201);
});

router.delete('/availability/blocks/:blockId', async (c) => {
  if (!uuidParam(c.req.param('blockId'))) return c.json({ error: 'Not found' }, 404);
  await db.delete(availabilityBlocks).where(and(eq(availabilityBlocks.id, c.req.param('blockId')), eq(availabilityBlocks.botId, c.get('bot').id)));
  return c.json({ success: true });
});

// ─── Share & calendar feed ──────────────────────────────────────────────────────

const apiBase = () => (process.env.API_PUBLIC_URL ?? 'http://localhost:3001').replace(/\/$/, '');

function feedUrls(botId: string, version: number) {
  const url = `${apiBase()}/api/feeds/booking/${signFeedToken(botId, version)}.ics`;
  return { url, webcal: url.replace(/^https?:/, 'webcal:') };
}

router.get('/share', async (c) => {
  const bot = c.get('bot');
  const settings = await ensureSettings(bot);
  const pageUrl = `${bookBase()}/${settings.pageSlug || bot.id}`;
  return c.json({
    pageUrl,
    embedButton: `<a href="${pageUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 22px;background:${bot.primaryColor ?? '#4F46E5'};color:#fff;border-radius:8px;font:600 15px sans-serif;text-decoration:none">Book an appointment</a>`,
    embedInline: `<iframe src="${pageUrl}?embed=1" style="width:100%;min-height:720px;border:0" title="Book an appointment"></iframe>`,
    feed: feedUrls(bot.id, settings.feedVersion),
  });
});

router.post('/feed/regenerate', async (c) => {
  const bot = c.get('bot');
  const settings = await ensureSettings(bot);
  const version = settings.feedVersion + 1;
  await db.update(bookingSettings).set({ feedVersion: version }).where(eq(bookingSettings.botId, bot.id));
  return c.json({ feed: feedUrls(bot.id, version) });
});

// ─── Emails: templates, preview, test, log ──────────────────────────────────────

const TEMPLATE_INFO: Record<TemplateName, { label: string; description: string }> = {
  'visitor.confirmed': { label: 'Booking confirmed', description: 'Sent to the visitor right after they book, with a calendar invite.' },
  'visitor.request_received': { label: 'Request received', description: 'For meeting types that need your approval.' },
  'visitor.approved': { label: 'Request approved', description: 'Sent when you approve a request.' },
  'visitor.declined': { label: 'Request declined', description: 'Sent when you decline a request.' },
  'visitor.rescheduled': { label: 'Time changed', description: 'Sent when an appointment is moved.' },
  'visitor.cancelled': { label: 'Cancelled', description: 'Sent when an appointment is cancelled.' },
  'visitor.reminder_24h': { label: 'Reminder · 24 hours', description: 'The day before the appointment.' },
  'visitor.reminder_1h': { label: 'Reminder · 1 hour', description: 'An hour before, with a join button.' },
  'visitor.follow_up': { label: 'Follow-up', description: 'Optional thank-you after the appointment.' },
  'visitor.otp': { label: 'Verification code', description: 'Lets a visitor manage their booking in chat.' },
  'owner.new_booking': { label: 'New booking alert', description: 'Sent to you with the visitor, answers and AI summary.' },
  'owner.approval_needed': { label: 'Approval needed', description: 'One-tap approve or decline.' },
  'owner.rescheduled': { label: 'Rescheduled alert', description: 'When a visitor moves their appointment.' },
  'owner.cancelled': { label: 'Cancelled alert', description: 'When a visitor cancels.' },
  'owner.daily_agenda': { label: 'Daily agenda', description: 'Your day at a glance, each morning.' },
  'owner.weekly_summary': { label: 'Weekly summary', description: 'Bookings, cancellations and trends each Monday.' },
};

router.get('/emails/templates', (c) =>
  c.json({ templates: (Object.keys(TEMPLATE_INFO) as TemplateName[]).map((id) => ({ id, audience: TEMPLATE_AUDIENCE[id], ...TEMPLATE_INFO[id] })) }));

router.get('/emails/preview/:template', async (c) => {
  const template = c.req.param('template');
  if (!isTemplateName(template)) return c.json({ error: 'Unknown template' }, 404);
  const bot = c.get('bot');
  const settings = await ensureSettings(bot);
  const rendered = renderEmail(template, sampleContext(bot, settings, c.get('user').email));
  return c.json(rendered);
});

router.post('/emails/test', jsonBody(z.object({ template: z.string() })), async (c) => {
  const { template } = c.req.valid('json');
  if (!isTemplateName(template)) return c.json({ error: 'Unknown template' }, 404);
  try {
    await sendTestEmail(c.get('bot').id, template, c.get('user').email);
  } catch (err) {
    return c.json({ error: `Could not send the test email: ${(err as Error).message}` }, 502);
  }
  return c.json({ success: true, to: c.get('user').email });
});

router.get('/emails/log', async (c) => {
  const bot = c.get('bot');
  const page = intParam(c.req.query('page'), 1, 1, 10_000);
  const pageSize = intParam(c.req.query('pageSize'), 25, 1, 100);
  const status = c.req.query('status');
  const where = and(eq(emailLog.botId, bot.id), status ? eq(emailLog.status, status) : undefined);
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(emailLog).where(where).orderBy(sql`${emailLog.createdAt} DESC`).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(emailLog).where(where),
  ]);
  return c.json({ rows, total, page, pageSize });
});

export default router;
