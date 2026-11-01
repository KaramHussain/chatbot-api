// Owner digests: a daily agenda each morning and a weekly summary each Monday, in the owner's timezone.
// Called every minute by the worker; a per-bot "last sent on" marker makes each digest send once.
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { bots, db } from '../db/index.js';
import { bookingSettings, bookings } from './schema.js';
import { ownerEmailsFor, brandFor, dashboardBookingUrl, fromFor, sampleContext } from './notify/notifier.js';
import { getMailer } from './notify/mailer.js';
import { renderEmail, type AgendaItem, type EmailCtx, type WeeklyStats } from './notify/templates.js';
import type { BookingSettings } from './core.js';
import { notifyOn } from './service.js';
import { getOverview } from './queries.js';
import { safeTimezone } from './time.js';
import { emailLog } from './schema.js';

const DAILY_HOUR = 7;
const WEEKLY_HOUR = 8; // Mondays

type BotRow = typeof bots.$inferSelect;

function digestContext(bot: BotRow, settings: BookingSettings, owners: string[]): EmailCtx {
  // Reuse the sample context shape for the fields a digest doesn't use, then override what matters.
  const base = sampleContext(bot, settings, owners[0]);
  return { ...base, brand: brandFor(bot, settings, owners[0]), links: { ...base.links, dashboard: `${(process.env.DASHBOARD_URL ?? 'https://chat.cloudgeniee.com').replace(/\/$/, '')}/client/bots/bookings/?id=${bot.id}&view=calendar` } };
}

async function send(bot: BotRow, settings: BookingSettings, owners: string[], template: 'owner.daily_agenda' | 'owner.weekly_summary', ctx: EmailCtx) {
  const rendered = renderEmail(template, ctx);
  const from = fromFor('owner', ctx.brand.name);
  for (const to of owners) {
    const [log] = await db.insert(emailLog).values({ tenantId: bot.tenantId, botId: bot.id, template, recipient: to, audience: 'owner', subject: rendered.subject }).returning({ id: emailLog.id });
    try {
      const { id } = await getMailer().send({ to, from, subject: rendered.subject, html: rendered.html, text: rendered.text });
      await db.update(emailLog).set({ status: 'sent', providerId: id, sentAt: new Date() }).where(eq(emailLog.id, log.id));
    } catch (err) {
      await db.update(emailLog).set({ status: 'failed', error: String((err as Error).message).slice(0, 400) }).where(eq(emailLog.id, log.id));
    }
  }
}

async function sendDaily(bot: BotRow, settings: BookingSettings, today: string) {
  const tz = safeTimezone(settings.timezone);
  const owners = await ownerEmailsFor(bot.tenantId, settings);
  if (!owners.length) return;
  const start = DateTime.fromISO(today, { zone: tz }).startOf('day');
  const rows = await db.select().from(bookings).where(and(
    eq(bookings.botId, bot.id), inArray(bookings.status, ['confirmed', 'pending']),
    gte(bookings.startsAt, start.toJSDate()), lt(bookings.startsAt, start.plus({ days: 1 }).toJSDate()),
  )).orderBy(asc(bookings.startsAt));
  const agenda: AgendaItem[] = rows.map((b) => ({
    start: b.startsAt, end: b.endsAt, name: b.visitorName ?? 'Guest', typeName: b.typeName ?? 'Appointment', status: b.status,
    url: dashboardBookingUrl(b.botId, b.id),
  }));
  const ctx = digestContext(bot, settings, owners);
  ctx.extra = { ...ctx.extra, agenda, dateLabel: 'Today' };
  await send(bot, settings, owners, 'owner.daily_agenda', ctx);
}

async function sendWeekly(bot: BotRow, settings: BookingSettings) {
  const owners = await ownerEmailsFor(bot.tenantId, settings);
  if (!owners.length) return;
  const tz = safeTimezone(settings.timezone);
  const o7 = await getOverview(bot.id, settings, 7);
  const last = DateTime.now().setZone(tz);
  const [row] = await db.select({
    cancelled: sql<number>`count(*) FILTER (WHERE status = 'cancelled')::int`,
    noShows: sql<number>`count(*) FILTER (WHERE status = 'no_show')::int`,
    confirmed: sql<number>`count(*) FILTER (WHERE status IN ('confirmed','completed'))::int`,
  }).from(bookings).where(and(eq(bookings.botId, bot.id), gte(bookings.createdAt, last.minus({ days: 7 }).toJSDate())));
  const busiest = [...o7.heatmap.reduce((m, h) => m.set(h.weekday, (m.get(h.weekday) ?? 0) + h.count), new Map<number, number>())].sort((a, b) => b[1] - a[1])[0];
  const weekly: WeeklyStats = {
    rangeLabel: `${last.minus({ days: 6 }).toFormat('d LLL')} – ${last.toFormat('d LLL')}`,
    total: o7.kpis.booked, previous: o7.kpis.bookedPrev, confirmed: row.confirmed, cancelled: row.cancelled, noShows: row.noShows,
    topType: o7.types[0]?.type, busiestDay: busiest ? DateTime.fromObject({ weekday: busiest[0] as 1 | 2 | 3 | 4 | 5 | 6 | 7 }).toFormat('cccc') : undefined,
    conversion: o7.kpis.conversion != null ? `${o7.kpis.conversion}%` : undefined,
  };
  const ctx = digestContext(bot, settings, owners);
  ctx.extra = { ...ctx.extra, weekly };
  await send(bot, settings, owners, 'owner.weekly_summary', ctx);
}

/** Look for digests that are due now. Safe to call as often as you like. */
export async function runDigestScheduler(now = new Date()): Promise<void> {
  const rows = await db.select().from(bookingSettings).where(eq(bookingSettings.enabled, true));
  for (const settings of rows) {
    const daily = notifyOn(settings, 'dailyAgenda');
    const weekly = notifyOn(settings, 'weeklySummary');
    if (!daily && !weekly) continue;
    const local = DateTime.fromJSDate(now, { zone: safeTimezone(settings.timezone) });
    const today = local.toISODate()!;
    const [bot] = await db.select().from(bots).where(eq(bots.id, settings.botId)).limit(1);
    if (!bot) continue;

    const patch: Record<string, string> = {};
    if (daily && local.hour >= DAILY_HOUR && settings.notify?.lastDailyOn !== today) {
      patch.lastDailyOn = today;
      await sendDaily(bot, settings, today).catch((err) => console.error('daily digest failed', err));
    }
    if (weekly && local.weekday === 1 && local.hour >= WEEKLY_HOUR && settings.notify?.lastWeeklyOn !== today) {
      patch.lastWeeklyOn = today;
      await sendWeekly(bot, settings).catch((err) => console.error('weekly digest failed', err));
    }
    if (Object.keys(patch).length) {
      await db.update(bookingSettings).set({ notify: { ...settings.notify, ...patch } }).where(eq(bookingSettings.botId, settings.botId));
    }
  }
}


