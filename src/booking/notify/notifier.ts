// Turns booking events into emails: builds the template context from the database, attaches the right
// calendar invite, sends through the Mailer and records every attempt in email_log.
import { and, eq, inArray } from 'drizzle-orm';
import { bots, db, users } from '../../db/index.js';
import { bookings, emailLog, meetingTypes, type Branding } from '../schema.js';
import { ensureSettings, type Booking, type BookingSettings, type MeetingType } from '../core.js';
import { safeTimezone, type TimeFormat } from '../time.js';
import { signActionToken, signManageToken } from '../tokens.js';
import { googleCalendarUrl, outlookCalendarUrl } from './calendar-links.js';
import { buildIcs, type IcsEvent, type IcsMethod } from './ics.js';
import { getMailer, mailFromAddress, type OutgoingMail } from './mailer.js';
import { TEMPLATE_AUDIENCE, isTemplateName, renderEmail, type EmailCtx, type Rendered, type TemplateName } from './templates.js';

const DASHBOARD_URL = () => (process.env.DASHBOARD_URL ?? 'https://chat.cloudgeniee.com').replace(/\/$/, '');
const API_URL = () => (process.env.API_PUBLIC_URL ?? 'http://localhost:3001').replace(/\/$/, '');
/** Public booking/manage pages. book.cloudgeniee.com once its DNS exists; the API host works meanwhile. */
export const bookBase = () => (process.env.BOOKING_PAGE_URL ?? `${API_URL()}/book`).replace(/\/$/, '');

type BotRow = typeof bots.$inferSelect;

export interface BookingContextData {
  booking: Booking;
  bot: BotRow;
  settings: BookingSettings;
  type: MeetingType | null;
  ownerEmails: string[];
}

export async function ownerEmailsFor(tenantId: string, settings: BookingSettings): Promise<string[]> {
  const admins = await db.select({ email: users.email }).from(users)
    .where(and(eq(users.tenantId, tenantId), inArray(users.role, ['client_admin'])));
  const extra = (settings.notify?.recipients ?? []).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  return [...new Set([...admins.map((a) => a.email), ...extra].map((e) => e.trim().toLowerCase()))];
}

export async function loadBookingContext(bookingId: string): Promise<BookingContextData | null> {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!booking) return null;
  const [bot] = await db.select().from(bots).where(eq(bots.id, booking.botId)).limit(1);
  if (!bot) return null;
  const settings = await ensureSettings({ id: bot.id, tenantId: bot.tenantId });
  const [type] = booking.meetingTypeId
    ? await db.select().from(meetingTypes).where(eq(meetingTypes.id, booking.meetingTypeId)).limit(1)
    : [];
  return { booking, bot, settings, type: type ?? null, ownerEmails: await ownerEmailsFor(bot.tenantId, settings) };
}

export function brandFor(bot: BotRow, settings: BookingSettings, ownerEmail?: string): EmailCtx['brand'] {
  const b: Branding = settings.branding ?? {};
  return {
    name: b.senderName?.trim() || bot.displayName?.trim() || bot.name,
    logoUrl: b.logoUrl || bot.logoUrl || null,
    accent: b.accent || bot.primaryColor || '#4F46E5',
    signOff: b.signOff || null,
    footer: b.footer || null,
    replyTo: b.replyTo?.trim() || ownerEmail || null,
  };
}

function locationOf(type: MeetingType | null, booking: Booking): EmailCtx['location'] {
  const snap = booking.locationSnapshot ?? {};
  const kind = (snap.type ?? type?.locationType ?? 'later') as EmailCtx['location']['kind'];
  return { kind: ['link', 'phone', 'in_person', 'later'].includes(kind) ? kind : 'later', value: snap.value ?? type?.locationValue ?? null };
}

function locationText(l: EmailCtx['location']): string | undefined {
  if (l.kind === 'later') return undefined;
  if (l.kind === 'phone') return `Phone call${l.value ? ` · ${l.value}` : ''}`;
  return l.value || (l.kind === 'in_person' ? 'In person' : undefined);
}

export function manageUrl(bookingId: string, action?: 'reschedule' | 'cancel'): string {
  const base = `${bookBase()}/m/${signManageToken(bookingId)}`;
  return action ? `${base}?action=${action}` : base;
}

export function dashboardBookingUrl(botId: string, bookingId: string): string {
  return `${DASHBOARD_URL()}/client/bots/bookings/?id=${botId}&view=appointments&booking=${bookingId}`;
}

export function dashboardConversationUrl(botId: string, conversationId: string): string {
  return `${DASHBOARD_URL()}/client/bots/detail/?id=${botId}&section=chats&conversation=${conversationId}`;
}

export function buildContext(data: BookingContextData, audience: 'visitor' | 'owner', extra?: EmailCtx['extra']): EmailCtx {
  const { booking: b, bot, settings, type } = data;
  const ownerEmail = data.ownerEmails[0];
  const tz = audience === 'visitor' ? safeTimezone(b.visitorTz, settings.timezone) : safeTimezone(settings.timezone);
  const location = locationOf(type, b);
  const brand = brandFor(bot, settings, ownerEmail);
  const questions = new Map((type?.questions ?? []).map((q) => [q.id, q.label]));
  const calendar = { title: `${b.typeName ?? type?.name ?? 'Appointment'} with ${brand.name}`, start: b.startsAt, end: b.endsAt, location: locationText(location) };

  return {
    brand,
    tz,
    timeFormat: (settings.timeFormat === '24h' ? '24h' : '12h') as TimeFormat,
    booking: {
      typeName: b.typeName ?? type?.name ?? 'Appointment',
      start: b.startsAt,
      end: b.endsAt,
      durationMin: Math.round((b.endsAt.getTime() - b.startsAt.getTime()) / 60_000),
      visitorName: b.visitorName ?? 'Guest',
      visitorEmail: b.visitorEmail ?? '',
      visitorPhone: b.visitorPhone,
      source: b.source,
      cancelReason: b.cancelReason,
      answers: Object.entries(b.answers ?? {}).map(([id, answer]) => ({ question: questions.get(id) ?? id, answer })),
      aiSummary: b.aiSummary,
    },
    location,
    priceText: type?.priceText,
    customMessage: type?.confirmationMessage || settings.notify?.confirmationMessage || null,
    links: {
      manage: manageUrl(b.id),
      reschedule: manageUrl(b.id, 'reschedule'),
      cancel: manageUrl(b.id, 'cancel'),
      approve: `${bookBase()}/a/${signActionToken(b.id, 'approve')}`,
      decline: `${bookBase()}/a/${signActionToken(b.id, 'decline')}`,
      dashboard: dashboardBookingUrl(b.botId, b.id),
      conversation: b.conversationId ? dashboardConversationUrl(b.botId, b.conversationId) : undefined,
      google: googleCalendarUrl(calendar),
      outlook: outlookCalendarUrl(calendar),
      ics: `${bookBase()}/ics/${signManageToken(b.id)}`,
      rebook: `${bookBase()}/${settings.pageSlug || b.botId}`,
      review: settings.notify?.reviewUrl || undefined,
    },
    extra: { ...extra, message: settings.notify?.followUpMessage ?? null },
  };
}

// ─── Calendar invite per template ──────────────────────────────────────────────

function inviteFor(template: TemplateName, ctx: EmailCtx, data: BookingContextData): { method: IcsMethod; content: string } | undefined {
  const { booking: b } = data;
  const base: Omit<IcsEvent, 'summary' | 'description'> = {
    uid: b.icsUid,
    sequence: b.icsSequence,
    start: b.startsAt,
    end: b.endsAt,
    location: locationText(ctx.location),
    url: /^https?:\/\//i.test(ctx.location.value ?? '') ? ctx.location.value ?? undefined : undefined,
    organizer: { name: ctx.brand.name, email: ctx.brand.replyTo ?? mailFromAddress().address },
    alarmMinutes: 30,
  };
  const summary = `${ctx.booking.typeName} with ${ctx.brand.name}`;
  const visitorDesc = [`${ctx.booking.typeName} with ${ctx.brand.name}`, '', `Reschedule or cancel: ${ctx.links.manage}`].join('\n');
  const attendee = { name: ctx.booking.visitorName, email: ctx.booking.visitorEmail };

  switch (template) {
    case 'visitor.confirmed':
    case 'visitor.approved':
    case 'visitor.rescheduled':
      return { method: 'REQUEST', content: buildIcs([{ ...base, summary, description: visitorDesc, attendee }], { method: 'REQUEST' }) };
    case 'visitor.cancelled':
      return { method: 'CANCEL', content: buildIcs([{ ...base, summary, attendee, status: 'CANCELLED' }], { method: 'CANCEL' }) };
    case 'owner.new_booking':
    case 'owner.rescheduled': {
      const desc = [`${ctx.booking.visitorName} · ${ctx.booking.visitorEmail}${ctx.booking.visitorPhone ? ` · ${ctx.booking.visitorPhone}` : ''}`, '', `Open in ChatGeniee: ${ctx.links.dashboard}`].join('\n');
      return { method: 'PUBLISH', content: buildIcs([{ ...base, summary: `${ctx.booking.typeName}: ${ctx.booking.visitorName}`, description: desc }], { method: 'PUBLISH' }) };
    }
    case 'owner.cancelled':
      return { method: 'CANCEL', content: buildIcs([{ ...base, summary: `${ctx.booking.typeName}: ${ctx.booking.visitorName}`, status: 'CANCELLED' }], { method: 'CANCEL' }) };
    default:
      return undefined;
  }
}

// ─── Sending ───────────────────────────────────────────────────────────────────

const ALLOWED_STATUS: Record<TemplateName, Array<Booking['status']>> = {
  'visitor.confirmed': ['confirmed', 'completed'],
  'visitor.approved': ['confirmed'],
  'visitor.request_received': ['pending', 'confirmed'],
  'visitor.declined': ['declined'],
  'visitor.rescheduled': ['confirmed', 'pending'],
  'visitor.cancelled': ['cancelled'],
  'visitor.reminder_24h': ['confirmed'],
  'visitor.reminder_1h': ['confirmed'],
  'visitor.follow_up': ['confirmed', 'completed'],
  'visitor.otp': ['confirmed', 'pending', 'completed', 'no_show', 'cancelled'],
  'owner.new_booking': ['confirmed', 'completed'],
  'owner.approval_needed': ['pending'],
  'owner.rescheduled': ['confirmed', 'pending'],
  'owner.cancelled': ['cancelled'],
  'owner.daily_agenda': [],
  'owner.weekly_summary': [],
};

export function fromFor(audience: 'visitor' | 'owner', brandName: string) {
  const from = mailFromAddress();
  return { name: audience === 'visitor' ? `${brandName} via ChatGeniee` : 'ChatGeniee Bookings', address: from.address };
}

async function deliver(
  opts: { tenantId: string; botId: string; bookingId?: string | null; jobId?: string; template: string; to: string; audience: 'visitor' | 'owner' },
  mail: OutgoingMail,
): Promise<void> {
  // One log row per (job, recipient): created on the first attempt, updated by retries.
  const existing = opts.jobId
    ? (await db.select({ id: emailLog.id }).from(emailLog).where(and(eq(emailLog.jobId, opts.jobId), eq(emailLog.recipient, opts.to))).limit(1))[0]
    : undefined;
  const logId = existing?.id
    ?? (await db.insert(emailLog).values({
      tenantId: opts.tenantId, botId: opts.botId, bookingId: opts.bookingId ?? null, template: opts.template,
      recipient: opts.to, audience: opts.audience, subject: mail.subject, jobId: opts.jobId ?? null,
    }).returning({ id: emailLog.id }))[0].id;
  try {
    const { id } = await getMailer().send(mail);
    await db.update(emailLog).set({ status: 'sent', providerId: id, sentAt: new Date(), error: null }).where(eq(emailLog.id, logId));
  } catch (err) {
    await db.update(emailLog).set({ status: 'failed', error: String((err as Error).message).slice(0, 400) }).where(eq(emailLog.id, logId));
    throw err;
  }
}

function toMail(rendered: Rendered, o: { to: string; from: OutgoingMail['from']; replyTo?: string | null; ical?: OutgoingMail['ical'] }): OutgoingMail {
  return { to: o.to, from: o.from, replyTo: o.replyTo ?? undefined, subject: rendered.subject, html: rendered.html, text: rendered.text, ical: o.ical };
}

/** Why a queued email should not go out any more. `null` = send it. */
export function skipReason(template: TemplateName, booking: Booking, now = new Date()): string | null {
  if (!ALLOWED_STATUS[template].includes(booking.status)) return `booking is ${booking.status}`;
  if ((template === 'visitor.reminder_24h' || template === 'visitor.reminder_1h') && booking.startsAt <= now) return 'meeting already started';
  return null;
}

/** Job handler: render and send one booking email. Throws on failure so the job retries. */
export async function processEmailJob(job: { id: string; bookingId: string | null; payload: Record<string, unknown> }): Promise<'sent' | 'skipped'> {
  const template = String(job.payload.template ?? '');
  if (!isTemplateName(template) || !job.bookingId) return 'skipped';
  const data = await loadBookingContext(job.bookingId);
  if (!data) return 'skipped';
  if (skipReason(template, data.booking)) return 'skipped';

  const audience = TEMPLATE_AUDIENCE[template];
  const ctx = buildContext(data, audience);
  const rendered = renderEmail(template, ctx);
  const ical = inviteFor(template, ctx, data);
  const from = fromFor(audience, ctx.brand.name);

  const recipients = audience === 'visitor' ? (data.booking.visitorEmail ? [data.booking.visitorEmail] : []) : data.ownerEmails;
  if (!recipients.length) return 'skipped';

  let failure: Error | null = null;
  for (const to of recipients) {
    try {
      await deliver(
        { tenantId: data.booking.tenantId, botId: data.booking.botId, bookingId: data.booking.id, jobId: job.id, template, to, audience },
        toMail(rendered, { to, from, ical, replyTo: audience === 'visitor' ? ctx.brand.replyTo : undefined }),
      );
    } catch (err) {
      failure = err as Error;
    }
  }
  if (failure) throw failure;
  return 'sent';
}

/** Sends a code to prove the visitor owns an email. Sent directly (not queued) so the code is never stored. */
export async function sendOtpEmail(bot: BotRow, email: string, code: string): Promise<void> {
  const settings = await ensureSettings({ id: bot.id, tenantId: bot.tenantId });
  const owners = await ownerEmailsFor(bot.tenantId, settings);
  const brand = brandFor(bot, settings, owners[0]);
  const ctx = { brand, tz: 'UTC', timeFormat: '12h', extra: { otp: code } } as unknown as EmailCtx;
  await deliver(
    { tenantId: bot.tenantId, botId: bot.id, template: 'visitor.otp', to: email, audience: 'visitor' },
    toMail(renderEmail('visitor.otp', ctx), { to: email, from: fromFor('visitor', brand.name), replyTo: brand.replyTo }),
  );
}

/** "Send me a test": renders any template with realistic sample data and sends it to the owner only. */
export async function sendTestEmail(botId: string, template: TemplateName, to: string): Promise<void> {
  const [bot] = await db.select().from(bots).where(eq(bots.id, botId)).limit(1);
  if (!bot) throw new Error('Bot not found');
  const settings = await ensureSettings({ id: bot.id, tenantId: bot.tenantId });
  const ctx = sampleContext(bot, settings, to);
  const audience = TEMPLATE_AUDIENCE[template];
  const rendered = renderEmail(template, ctx);
  const fakeData = { booking: { icsUid: 'sample@cloudgeniee.com', icsSequence: 0, startsAt: ctx.booking.start, endsAt: ctx.booking.end } } as unknown as BookingContextData;
  await deliver(
    { tenantId: bot.tenantId, botId: bot.id, template: `${template}.test`, to, audience },
    toMail({ ...rendered, subject: `[Test] ${rendered.subject}` }, { to, from: fromFor(audience, ctx.brand.name), ical: inviteFor(template, ctx, fakeData), replyTo: audience === 'visitor' ? ctx.brand.replyTo : undefined }),
  );
}

/** Realistic sample data for previews and test sends. */
export function sampleContext(bot: BotRow, settings: BookingSettings, ownerEmail?: string): EmailCtx {
  const start = new Date(Date.now() + 2 * 24 * 3600_000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60_000);
  const brand = brandFor(bot, settings, ownerEmail);
  const calendar = { title: `Consultation with ${brand.name}`, start, end };
  return {
    brand,
    tz: safeTimezone(settings.timezone),
    timeFormat: settings.timeFormat === '24h' ? '24h' : '12h',
    booking: {
      typeName: 'Consultation', start, end, durationMin: 30, visitorName: 'Sara Khan', visitorEmail: 'sara@example.com',
      visitorPhone: '+1 555 0100', source: 'chat', cancelReason: null,
      answers: [{ question: 'Is this your first visit?', answer: 'Yes' }],
      aiSummary: { intent: 'Wants a first consultation and asked about pricing for whitening.', keyFacts: ['First-time visitor', 'Interested in whitening'], questions: ['How much does whitening cost?'], sentiment: 'positive' },
    },
    location: { kind: 'link', value: 'https://meet.example.com/consultation' },
    priceText: null,
    customMessage: settings.notify?.confirmationMessage ?? null,
    links: {
      manage: '#', reschedule: '#', cancel: '#', approve: '#', decline: '#', dashboard: DASHBOARD_URL(), conversation: DASHBOARD_URL(),
      google: googleCalendarUrl(calendar), outlook: outlookCalendarUrl(calendar), ics: '#', rebook: '#', review: settings.notify?.reviewUrl || undefined,
    },
    extra: {
      oldStart: new Date(start.getTime() - 24 * 3600_000), otp: '482913', reason: 'Sample reason',
      dateLabel: 'Today',
      agenda: [
        { start, end, name: 'Sara Khan', typeName: 'Consultation', status: 'confirmed' },
        { start: new Date(start.getTime() + 3600_000), end: new Date(end.getTime() + 3600_000), name: 'Omar Ali', typeName: 'Follow-up', status: 'confirmed' },
      ],
      weekly: { rangeLabel: 'Last 7 days', total: 14, previous: 9, confirmed: 11, cancelled: 2, noShows: 1, topType: 'Consultation', busiestDay: 'Wednesday', conversion: '18%' },
    },
  };
}
