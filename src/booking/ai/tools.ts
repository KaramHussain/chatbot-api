// The booking tools the chat AI can call. They are thin and defensive: every write goes through
// BookingService, state lives in the database (not in the model's memory), and nothing here trusts the
// model's arguments — slots must pass the availability engine, manage actions require a verified email.
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { conversations, db } from '../../db/index.js';
import type { Bot } from '../../lib/conversation.js';
import { BookingError, getMeetingType, listActiveTypes, type Booking, type BookingSettings, type MeetingType } from '../core.js';
import { bookings } from '../schema.js';
import {
  bookingsForEmail, cancelBooking, confirmBooking, hasAnyAvailability, holdSlot, listSlots, rescheduleBooking,
} from '../service.js';
import { requestOtp, verifiedEmailOf, verifyOtpForConversation } from '../otp.js';
import { signManageToken, normalizeEmail } from '../tokens.js';
import { formatDateTime, formatDay, formatTime, localDate, zoneAbbreviation, type TimeFormat } from '../time.js';
import { googleCalendarUrl, outlookCalendarUrl } from '../notify/calendar-links.js';
import { bookBase, manageUrl } from '../notify/notifier.js';
import type { EmitUi, SlotChoice } from './ui-events.js';

export interface ToolContext {
  bot: Bot;
  settings: BookingSettings;
  conversationId: string;
  visitorTz: string;
  emit: EmitUi;
  clientIp?: string;
}

export interface ToolSpec { toolSpec: { name: string; description: string; inputSchema: { json: Record<string, unknown> } } }

const spec = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolSpec => ({
  toolSpec: { name, description, inputSchema: { json: { type: 'object', properties, required } } },
});

const str = (description: string) => ({ type: 'string', description });

export function bookingToolSpecs(): ToolSpec[] {
  return [
    spec('list_meeting_types', 'List what the visitor can book (names, durations, descriptions, the questions each one asks).'),
    spec('find_available_slots',
      'Find REAL open times and show them to the visitor as tappable buttons. ALWAYS call this before stating or implying any availability. Pass exactly what the visitor asked for (a day, a time, a time range, "other than Monday"...). The result says whether a requested time is available.',
      {
        meeting_type: str('Name of the meeting type (omit if there is only one).'),
        from_date: str('Earliest day, YYYY-MM-DD in the visitor\'s time zone. Default: today.'),
        to_date: str('Latest day, YYYY-MM-DD. For one specific day set from_date and to_date to that day.'),
        weekday: str('Only this weekday, e.g. "friday".'),
        exclude_weekday: str('Skip this weekday, e.g. "monday" for "any day other than Monday".'),
        time: str('A specific time the visitor wants, 24-hour HH:mm (e.g. "15:00" for 3 pm). The result says whether it is available and offers the closest times if not.'),
        time_from: str('Start of a time range, 24-hour HH:mm.'),
        time_to: str('End of a time range, 24-hour HH:mm.'),
        part_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening'], description: 'Visitor preference.' },
        full_week: { type: 'boolean', description: 'true = every open time for the next 7 days (only after the visitor said yes to seeing the full week).' },
        earliest: { type: 'boolean', description: 'true = just the soonest few times.' },
      }),
    spec('hold_slot', 'Reserve a time for 10 minutes while collecting details. Use the exact `start` from the latest find_available_slots result.',
      { meeting_type: str('Meeting type name (omit if only one).'), start: str('Exact ISO start from find_available_slots.') }, ['start']),
    spec('save_details', 'Remember details the visitor gave (call after each answer). Never ask again for what is saved.',
      {
        name: str('Full name'), email: str('Email address'), phone: str('Phone number'),
        answers: { type: 'object', description: 'Answers to the meeting type\'s questions, keyed by question text.', additionalProperties: { type: 'string' } },
      }),
    spec('present_summary', 'Show the visitor a confirmation card for the held time and saved details. Call once everything is collected, then ask them to confirm.'),
    spec('create_booking', 'Confirm the booking. ONLY after the visitor clearly said yes/confirm to the summary.'),
    spec('send_verification_code', 'Email a 6-digit code to prove the visitor owns an email before managing a booking.', { email: str('The email they booked with.') }, ['email']),
    spec('verify_code', 'Check the 6-digit code the visitor was emailed.', { email: str('Email'), code: str('6-digit code') }, ['email', 'code']),
    spec('list_my_bookings', 'The verified visitor\'s upcoming bookings. Requires verification.'),
    spec('reschedule_booking', 'Move a verified visitor\'s booking to a new time from find_available_slots.', { booking_id: str('Booking id'), new_start: str('Exact ISO start') }, ['booking_id', 'new_start']),
    spec('cancel_booking', 'Cancel a verified visitor\'s booking (after they confirmed).', { booking_id: str('Booking id'), reason: str('Optional reason') }, ['booking_id']),
  ];
}

// ─── helpers ────────────────────────────────────────────────────────────────────

const fmt = (s: BookingSettings): TimeFormat => (s.timeFormat === '24h' ? '24h' : '12h');
const whenLabel = (start: Date, ctx: ToolContext) => `${formatDateTime(start, ctx.visitorTz, fmt(ctx.settings))} (${zoneAbbreviation(start, ctx.visitorTz)})`;
const WEEKDAYS: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

async function resolveType(ctx: ToolContext, ref?: string): Promise<MeetingType> {
  const types = await listActiveTypes(ctx.bot.id);
  if (!types.length) throw new BookingError('not_found', 'There is nothing to book yet.', 404);
  const q = ref?.trim().toLowerCase();
  if (!q) {
    if (types.length === 1) return types[0];
    throw new BookingError('invalid_input', `Which one? Options: ${types.map((t) => t.name).join(', ')}`);
  }
  const found = types.find((t) => t.id === q || t.slug === q || t.name.toLowerCase() === q)
    ?? types.find((t) => t.name.toLowerCase().includes(q) || q.includes(t.name.toLowerCase()));
  if (!found) throw new BookingError('not_found', `No meeting type called "${ref}". Options: ${types.map((t) => t.name).join(', ')}`, 404);
  return found;
}

export async function activeHold(conversationId: string): Promise<Booking | undefined> {
  const [row] = await db.select().from(bookings).where(and(
    eq(bookings.conversationId, conversationId), eq(bookings.status, 'held'), gt(bookings.holdExpiresAt, new Date()),
  )).orderBy(desc(bookings.createdAt)).limit(1);
  return row;
}

export interface SavedDetails { name: string | null; email: string | null; phone: string | null; answers: Record<string, string>; summaryHoldId: string | null }

export async function savedDetails(conversationId: string): Promise<SavedDetails> {
  const [c] = await db.select({ name: conversations.visitorName, email: conversations.visitorEmail, phone: conversations.visitorPhone, lead: conversations.leadData })
    .from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  const lead = (c?.lead ?? {}) as { bookingAnswers?: Record<string, string>; summaryHoldId?: string };
  return { name: c?.name ?? null, email: c?.email ?? null, phone: c?.phone ?? null, answers: lead.bookingAnswers ?? {}, summaryHoldId: lead.summaryHoldId ?? null };
}

/** "15:00", "3pm", "3:30 pm", "15" -> minutes after midnight. */
function toMinutes(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return h > 23 || min > 59 ? null : h * 60 + min;
}

/** Merge small bits of booking state into the conversation (lead_data JSON). */
async function remember(conversationId: string, patch: Record<string, unknown>) {
  await db.update(conversations)
    .set({ leadData: sql`coalesce(${conversations.leadData}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(conversations.id, conversationId));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** What is still missing before a booking can be confirmed. */
export function missingFor(type: MeetingType, settings: BookingSettings, d: SavedDetails): string[] {
  const missing: string[] = [];
  if (!d.name) missing.push('name');
  if (!d.email) missing.push('email');
  if (settings.requirePhone && !d.phone) missing.push('phone');
  for (const q of type.questions) {
    if (q.required && !(d.answers[q.id] ?? d.answers[q.label])) missing.push(`answer to: "${q.label}"`);
  }
  return missing;
}

function matchAnswers(type: MeetingType, raw: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const q = type.questions.find((x) => x.id === k || x.label.toLowerCase() === k.toLowerCase())
      ?? type.questions.find((x) => x.label.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(x.label.toLowerCase()));
    if (q && v != null && String(v).trim()) out[q.id] = String(v).trim().slice(0, 1000);
  }
  return out;
}

const locationText = (t: MeetingType): string | null =>
  t.locationType === 'link' ? t.locationValue ?? 'Online' : t.locationType === 'phone' ? `Phone call${t.locationValue ? ` · ${t.locationValue}` : ''}` : t.locationType === 'in_person' ? t.locationValue ?? 'In person' : null;

// ─── runner ─────────────────────────────────────────────────────────────────────

export type ToolRunner = (name: string, input: Record<string, unknown>) => Promise<unknown>;

export function createToolRunner(ctx: ToolContext): ToolRunner {
  const tz = ctx.visitorTz;
  const f = fmt(ctx.settings);
  let searches = 0;

  /** Emit the confirmation card and remember which hold it was shown for. */
  async function showSummary(hold: Booking, type: MeetingType, d: SavedDetails) {
    ctx.emit({
      kind: 'confirm', typeName: type.name, when: formatDateTime(hold.startsAt, tz, f), durationMin: type.durationMin, tzLabel: zoneAbbreviation(hold.startsAt, tz),
      name: d.name!, email: d.email!, phone: d.phone, where: locationText(type), price: type.priceText, needsApproval: type.confirmation === 'approval',
    });
    await db.update(conversations)
      .set({ leadData: sql`jsonb_set(coalesce(${conversations.leadData}, '{}'::jsonb), '{summaryHoldId}', to_jsonb(${hold.id}::text))` })
      .where(eq(conversations.id, ctx.conversationId));
  }

  const handlers: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
    async list_meeting_types() {
      const types = await listActiveTypes(ctx.bot.id);
      if (types.length > 1) ctx.emit({ kind: 'types', types: types.map((t) => ({ id: t.id, name: t.name, durationMin: t.durationMin, description: t.description, priceText: t.priceText })) });
      return {
        meeting_types: types.map((t) => ({ name: t.name, duration_min: t.durationMin, description: t.description, price: t.priceText, needs_approval: t.confirmation === 'approval', questions: t.questions.map((q) => ({ question: q.label, required: q.required, options: q.options })) })),
        note: 'Shown to the visitor as tappable options.',
      };
    },

    async find_available_slots(input) {
      if (++searches > 3) return { error: 'Too many searches this turn — answer with what you have.' };
      const type = await resolveType(ctx, input.meeting_type as string | undefined);
      await remember(ctx.conversationId, { lastTypeName: type.name }); // lets "yes, send the full week" know which meeting

      const now = new Date();
      const day = (v: unknown) => {
        const d = typeof v === 'string' ? DateTime.fromISO(v, { zone: tz }) : null;
        return d?.isValid ? d.startOf('day') : null;
      };
      const fullWeek = input.full_week === true;
      const fromDay = day(input.from_date);
      const from = fromDay && fromDay.toJSDate() > now ? fromDay.toJSDate() : now;
      const toDay = day(input.to_date);
      const to = toDay ? toDay.endOf('day').toJSDate() : DateTime.fromJSDate(from, { zone: tz }).startOf('day').plus({ days: fullWeek ? 7 : 14 }).toJSDate();
      const weekday = typeof input.weekday === 'string' ? WEEKDAYS[input.weekday.toLowerCase()] : undefined;
      const exWeekday = typeof input.exclude_weekday === 'string' ? WEEKDAYS[input.exclude_weekday.toLowerCase()] : undefined;
      const partOfDay = ['morning', 'afternoon', 'evening'].includes(String(input.part_of_day)) ? (input.part_of_day as 'morning' | 'afternoon' | 'evening') : undefined;
      const wantTime = toMinutes(input.time);
      const rangeFrom = toMinutes(input.time_from);
      const rangeTo = toMinutes(input.time_to);
      const mins = (d: Date) => { const l = DateTime.fromJSDate(d, { zone: tz }); return l.hour * 60 + l.minute; };

      let slots = (await listSlots({ botId: ctx.bot.id, typeId: type.id, from, to, zone: tz, partOfDay, weekday })).slots;
      if (exWeekday) slots = slots.filter((x) => DateTime.fromJSDate(x.start, { zone: tz }).weekday !== exWeekday);
      if (rangeFrom !== null) slots = slots.filter((x) => mins(x.start) >= rangeFrom && (rangeTo === null || mins(x.start) < rangeTo));

      // A specific time: show it where it's free; where it isn't, the closest time each day — and say which.
      let exact: boolean | undefined;
      let shown = slots;
      if (wantTime !== null) {
        const matches = slots.filter((x) => mins(x.start) === wantTime);
        exact = matches.length > 0;
        if (exact) shown = matches;
        else {
          const closest = new Map<string, (typeof slots)[number]>();
          for (const x of slots) {
            const k = localDate(x.start, tz);
            const cur = closest.get(k);
            if (!cur || Math.abs(mins(x.start) - wantTime) < Math.abs(mins(cur.start) - wantTime)) closest.set(k, x);
          }
          shown = [...closest.values()].slice(0, 6);
        }
      }
      if (input.earliest === true) shown = shown.slice(0, 3);
      shown = shown.slice(0, 120);

      if (!shown.length) {
        const any = await hasAnyAvailability(ctx.bot.id, type.id);
        return {
          slots: [], ...(wantTime !== null ? { exact_match: false } : {}),
          note: any
            ? 'Nothing is open for that. Say so plainly, and ask what else would work (another day or time), or offer to send the full week.'
            : `Fully booked for now. ${ctx.settings.whenFull === 'phone' ? 'Suggest they contact the business directly.' : ctx.settings.whenFull === 'waitlist' ? 'Offer to take their email so the business can reach out when a time opens.' : 'Offer to take their name and email so the business can contact them.'}`,
        };
      }

      const choices: SlotChoice[] = shown.map((x) => ({ start: x.start.toISOString(), dayLabel: formatDay(x.start, tz), timeLabel: formatTime(x.start, tz, f) }));
      const last = shown[shown.length - 1].start;
      ctx.emit({
        kind: 'slots', typeId: type.id, typeName: type.name, durationMin: type.durationMin, timezone: tz, tzLabel: zoneAbbreviation(shown[0].start, tz),
        slots: choices, moreFrom: fullWeek || wantTime !== null ? null : DateTime.fromJSDate(last, { zone: tz }).plus({ days: 1 }).toISODate(),
      });

      const perDay = new Map<string, string[]>();
      for (const x of shown) {
        const label = formatDay(x.start, tz);
        (perDay.get(label) ?? perDay.set(label, []).get(label)!).push(formatTime(x.start, tz, f));
      }
      return {
        meeting_type: type.name,
        timezone: tz,
        ...(wantTime !== null ? { requested_time: `${String(Math.floor(wantTime / 60)).padStart(2, '0')}:${String(wantTime % 60).padStart(2, '0')}`, exact_match: exact } : {}),
        open_times: [...perDay].map(([d, times]) => ({ day: d, times: times.join(', ') })),
        // Exact starts only when the list is short enough to pick from; otherwise narrow with `time`/dates first.
        ...(shown.length <= 12 ? { starts: shown.map((x) => ({ start: x.start.toISOString(), label: whenLabel(x.start, ctx) })) } : {}),
        note: [
          exact === false ? 'The requested time is NOT available on any of these days; the times shown are the closest each day. Say clearly that it is not available.' : '',
          exact === true ? 'The requested time IS available on the days shown.' : '',
          'All of this is on screen as tappable buttons. Reply in one or two short sentences (which days are open, or yes/no for the time asked); do not list every time.',
        ].filter(Boolean).join(' '),
      };
    },

    async hold_slot(input) {
      const type = await resolveType(ctx, input.meeting_type as string | undefined);
      const start = new Date(String(input.start));
      if (Number.isNaN(start.getTime())) return { error: 'Invalid start time — use the exact start from find_available_slots.' };
      const hold = await holdSlot({ botId: ctx.bot.id, typeId: type.id, start, conversationId: ctx.conversationId, visitorTz: tz, source: 'chat' });
      return { held: true, meeting_type: type.name, when: whenLabel(hold.startsAt, ctx), held_for_minutes: 10 };
    },

    async save_details(input) {
      const patch: Partial<typeof conversations.$inferInsert> = {};
      if (typeof input.name === 'string' && input.name.trim()) patch.visitorName = input.name.trim().slice(0, 120);
      if (typeof input.email === 'string' && input.email.trim()) {
        if (!EMAIL_RE.test(input.email.trim())) return { error: 'That email does not look valid — ask the visitor to double-check it.' };
        patch.visitorEmail = input.email.trim().slice(0, 200);
      }
      if (typeof input.phone === 'string' && input.phone.trim()) patch.visitorPhone = input.phone.trim().slice(0, 40);
      const hold = await activeHold(ctx.conversationId);
      const type = hold?.meetingTypeId ? await getMeetingType(ctx.bot.id, hold.meetingTypeId) : undefined;
      const answers = type ? matchAnswers(type, input.answers as Record<string, unknown> | undefined) : {};
      if (Object.keys(patch).length) await db.update(conversations).set(patch).where(eq(conversations.id, ctx.conversationId));
      if (Object.keys(answers).length) {
        await db.update(conversations)
          .set({ leadData: sql`jsonb_set(coalesce(${conversations.leadData}, '{}'::jsonb), '{bookingAnswers}', coalesce(${conversations.leadData}->'bookingAnswers', '{}'::jsonb) || ${JSON.stringify(answers)}::jsonb)` })
          .where(eq(conversations.id, ctx.conversationId));
      }
      const d = await savedDetails(ctx.conversationId);
      const stillMissing = type ? missingFor(type, ctx.settings, d) : [];
      // Nothing left to ask → show the confirmation card right here (never left to the model to remember).
      if (hold && type && !stillMissing.length) {
        await showSummary(hold, type, d);
        return { saved: true, still_missing: [], summary_shown: true, next_step: 'The confirmation card is on screen. Ask the visitor to confirm, in one short sentence.' };
      }
      return { saved: true, still_missing: stillMissing, next_step: stillMissing.length ? `Ask the visitor for their ${stillMissing[0]} (one short question).` : 'Continue.' };
    },

    async present_summary() {
      const hold = await activeHold(ctx.conversationId);
      if (!hold?.meetingTypeId) return { error: 'No time is being held. Find and hold a time first.' };
      const type = await getMeetingType(ctx.bot.id, hold.meetingTypeId);
      if (!type) return { error: 'That meeting type no longer exists.' };
      const d = await savedDetails(ctx.conversationId);
      const missing = missingFor(type, ctx.settings, d);
      if (missing.length) return { error: 'Details are still missing — ask for them first (one at a time).', missing };
      await showSummary(hold, type, d);
      return { shown: true, note: 'A confirmation card is on screen. Ask the visitor to confirm; do not repeat all the details.' };
    },

    async create_booking() {
      const hold = await activeHold(ctx.conversationId);
      if (!hold) {
        // Retry-safe: already booked in this conversation?
        const [done] = await db.select().from(bookings).where(and(eq(bookings.conversationId, ctx.conversationId), sql`${bookings.status} IN ('confirmed','pending')`)).orderBy(desc(bookings.createdAt)).limit(1);
        if (done) return { booked: true, status: done.status, when: whenLabel(done.startsAt, ctx), note: 'Already booked.' };
        return { error: 'The held time expired or none was held. Find a time again.' };
      }
      const type = hold.meetingTypeId ? await getMeetingType(ctx.bot.id, hold.meetingTypeId) : undefined;
      if (!type) return { error: 'That meeting type no longer exists.' };
      const d = await savedDetails(ctx.conversationId);
      const missing = missingFor(type, ctx.settings, d);
      if (missing.length) return { error: 'Details are still missing.', missing };

      const { booking } = await confirmBooking({
        botId: ctx.bot.id, holdId: hold.id, name: d.name!, email: d.email!, phone: d.phone, answers: d.answers, conversationId: ctx.conversationId, actor: 'ai',
      });
      const title = `${type.name} with ${ctx.bot.displayName || ctx.bot.name}`;
      const cal = { title, start: booking.startsAt, end: booking.endsAt, location: locationText(type) ?? undefined };
      const token = signManageToken(booking.id);
      ctx.emit({
        kind: 'booked', status: booking.status === 'pending' ? 'pending' : 'confirmed', typeName: type.name, when: formatDateTime(booking.startsAt, tz, f),
        durationMin: type.durationMin, tzLabel: zoneAbbreviation(booking.startsAt, tz), email: d.email!, where: locationText(type),
        manageUrl: manageUrl(booking.id), googleUrl: googleCalendarUrl(cal), outlookUrl: outlookCalendarUrl(cal), icsUrl: `${bookBase()}/ics/${token}`,
      });
      return { booked: true, status: booking.status, when: whenLabel(booking.startsAt, ctx), note: booking.status === 'pending' ? 'It needs the business to approve it; they will email the visitor.' : `A calendar invite was emailed to ${d.email}.` };
    },

    async send_verification_code(input) {
      const email = String(input.email ?? '').trim();
      await requestOtp(ctx.bot.id, email, ctx.clientIp);
      return { sent: true, note: 'If that email has upcoming bookings, a 6-digit code was sent. Do not say whether any booking exists. Ask for the code.' };
    },

    async verify_code(input) {
      const ok = await verifyOtpForConversation(ctx.bot.id, ctx.conversationId, String(input.email ?? ''), String(input.code ?? ''));
      return ok ? { verified: true, note: 'Verified. Their upcoming bookings are in the "Verified bookings" section next turn; call list_my_bookings now.' } : { verified: false, note: 'Wrong or expired code. They can retry or request a new code.' };
    },

    async list_my_bookings() {
      const email = await verifiedEmailOf(ctx.conversationId);
      if (!email) return { error: 'Not verified. Send and verify a code first.' };
      const list = await bookingsForEmail(ctx.bot.id, email);
      return { bookings: list.map((b) => ({ booking_id: b.id, meeting_type: b.typeName, when: whenLabel(b.startsAt, ctx), status: b.status })) };
    },

    async reschedule_booking(input) {
      const b = await ownedBooking(ctx, String(input.booking_id ?? ''));
      const start = new Date(String(input.new_start));
      if (Number.isNaN(start.getTime())) return { error: 'Invalid time — use the exact start from find_available_slots.' };
      const updated = await rescheduleBooking(ctx.bot.id, b.id, start, { actor: 'visitor' });
      return { rescheduled: true, when: whenLabel(updated.startsAt, ctx), note: 'An updated invite was emailed.' };
    },

    async cancel_booking(input) {
      const b = await ownedBooking(ctx, String(input.booking_id ?? ''));
      await cancelBooking(ctx.bot.id, b.id, { actor: 'visitor', reason: typeof input.reason === 'string' ? input.reason : null });
      return { cancelled: true, note: 'A cancellation email was sent.' };
    },
  };

  return async (name, input) => {
    const handler = handlers[name];
    if (!handler) return { error: `Unknown tool ${name}` };
    try {
      return await handler(input ?? {});
    } catch (err) {
      if (err instanceof BookingError) return { error: err.message, code: err.code };
      console.error(JSON.stringify({ evt: 'booking_tool_error', tool: name, error: (err as Error).message }));
      return { error: 'Something went wrong. Apologise briefly and try once more.' };
    }
  };
}

/** A booking the verified visitor is allowed to touch. */
async function ownedBooking(ctx: ToolContext, id: string): Promise<Booking> {
  const email = await verifiedEmailOf(ctx.conversationId);
  if (!email) throw new BookingError('forbidden', 'Not verified. Send and verify a code first.', 403);
  const list = await bookingsForEmail(ctx.bot.id, email);
  const b = list.find((x) => x.id === id);
  if (!b || (b.visitorEmail && normalizeEmail(b.visitorEmail) !== email)) throw new BookingError('not_found', 'No upcoming booking with that id for the verified email.', 404);
  return b;
}
