// BookingService — the ONLY place booking rows are written. The chat AI, voice agent, hosted pages and
// dashboard all call these functions, so they behave identically and share the same guarantees:
//   • a time is only ever held/booked if the availability engine currently offers it,
//   • the database exclusion constraint makes double booking impossible even under races,
//   • every state change writes a booking_events row and queues its emails as jobs.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bookingEvents, bookingNotes, bookingPeople, bookings } from './schema.js';
import { computeSlots, filterSlots, isSlotOffered, suggestSlots, type Slot, type SlotFilter } from './availability.js';
import {
  BookingError, HOLD_MINUTES, blockRange, ensureSettings, expireStaleHolds, getMeetingType, getSettings,
  isOverlapViolation, listActiveTypes, loadEngineContext,
  type Booking, type BookingSettings, type MeetingType, type Tx,
} from './core.js';
import { cancelScheduledEmails, enqueueEmail, enqueueJob } from './jobs.js';
import { normalizeEmail, normalizePhone, signManageToken, verifyManageToken } from './tokens.js';
import { addMinutes, safeTimezone } from './time.js';
import type { IntakeQuestion, NotifyConfig } from './schema.js';

export type Actor = 'visitor' | 'owner' | 'ai' | 'system';

export const NOTIFY_DEFAULTS: Required<Pick<NotifyConfig,
  'ownerNewBooking' | 'ownerChanges' | 'visitorConfirmation' | 'visitorChanges' | 'reminder24h' | 'reminder1h' | 'followUp' | 'dailyAgenda' | 'weeklySummary'>> = {
  ownerNewBooking: true, ownerChanges: true, visitorConfirmation: true, visitorChanges: true,
  reminder24h: true, reminder1h: true, followUp: false, dailyAgenda: false, weeklySummary: false,
};

export function notifyOn(settings: BookingSettings, key: keyof typeof NOTIFY_DEFAULTS): boolean {
  return settings.notify?.[key] ?? NOTIFY_DEFAULTS[key];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function logEvent(
  tx: Tx | typeof db, b: Pick<Booking, 'id' | 'botId'>, type: string, actor: Actor,
  data: Record<string, unknown> = {}, actorUserId?: string,
) {
  await tx.insert(bookingEvents).values({ bookingId: b.id, botId: b.botId, type, actor, data, actorUserId });
}

// ─── Slots ──────────────────────────────────────────────────────────────────────

export interface SlotQuery extends SlotFilter {
  botId: string;
  typeId: string;
  from?: Date;
  to?: Date;
  now?: Date;
}

export async function listSlots(q: SlotQuery): Promise<{ slots: Slot[]; type: MeetingType; settings: BookingSettings }> {
  const settings = await getSettings(q.botId);
  if (!settings?.enabled) throw new BookingError('disabled', 'Booking is not enabled for this bot.', 403);
  if (settings.paused) throw new BookingError('paused', settings.pauseMessage || 'Bookings are paused right now.', 409);
  const type = await getMeetingType(q.botId, q.typeId);
  if (!type || !type.active) throw new BookingError('not_found', 'That meeting type does not exist.', 404);

  const now = q.now ?? new Date();
  const from = q.from ?? now;
  const to = q.to ?? addMinutes(now, 14 * 24 * 60);
  await expireStaleHolds(q.botId);
  const ctx = await loadEngineContext(settings, type, from, to, { now });
  const slots = filterSlots(computeSlots({ ...ctx, range: { start: from, end: to } }), q);
  return { slots, type, settings };
}

/** The handful of slots worth showing first (spread across the next few days). */
export async function suggestedSlots(q: SlotQuery, days = 3, perDay = 3) {
  const res = await listSlots(q);
  const zone = q.zone ?? safeTimezone(res.settings.timezone);
  return { ...res, suggested: suggestSlots(res.slots, zone, days, perDay) };
}

/** Is there any open time at all in the booking window? Drives the "fully booked" behaviour. */
export async function hasAnyAvailability(botId: string, typeId: string): Promise<boolean> {
  const settings = await getSettings(botId);
  const type = await getMeetingType(botId, typeId);
  if (!settings || !type) return false;
  const now = new Date();
  const to = addMinutes(now, (type.windowDays ?? settings.windowDays) * 24 * 60);
  const ctx = await loadEngineContext(settings, type, now, to, { now });
  return computeSlots({ ...ctx, range: { start: now, end: to } }).length > 0;
}

// ─── Hold ───────────────────────────────────────────────────────────────────────

export interface HoldInput {
  botId: string;
  typeId: string;
  start: Date;
  conversationId?: string | null;
  visitorTz?: string | null;
  source?: 'chat' | 'voice' | 'page' | 'manual';
}

/** Reserve a time for HOLD_MINUTES while the visitor gives their details. One live hold per conversation. */
export async function holdSlot(input: HoldInput): Promise<Booking> {
  const settings = await getSettings(input.botId);
  if (!settings?.enabled) throw new BookingError('disabled', 'Booking is not enabled for this bot.', 403);
  if (settings.paused) throw new BookingError('paused', settings.pauseMessage || 'Bookings are paused right now.', 409);
  const type = await getMeetingType(input.botId, input.typeId);
  if (!type || !type.active) throw new BookingError('not_found', 'That meeting type does not exist.', 404);

  await expireStaleHolds(input.botId);
  if (input.conversationId) {
    await db.update(bookings).set({ status: 'expired', updatedAt: new Date() }).where(and(
      eq(bookings.conversationId, input.conversationId), eq(bookings.status, 'held'),
    ));
  }

  const ctx = await loadEngineContext(settings, type, input.start, input.start);
  if (!isSlotOffered(ctx, input.start)) {
    throw new BookingError('slot_unavailable', 'That time is not available. Please pick another.', 409);
  }

  const end = addMinutes(input.start, type.durationMin);
  try {
    const [row] = await db.insert(bookings).values({
      botId: input.botId,
      tenantId: settings.tenantId,
      meetingTypeId: type.id,
      conversationId: input.conversationId ?? null,
      status: 'held',
      startsAt: input.start,
      endsAt: end,
      ...blockRange(input.start, end, type),
      typeName: type.name,
      visitorTz: input.visitorTz ?? null,
      source: input.source ?? 'chat',
      locationSnapshot: { type: type.locationType, value: type.locationValue },
      holdExpiresAt: addMinutes(new Date(), HOLD_MINUTES),
      icsUid: `${crypto.randomUUID()}@cloudgeniee.com`,
    }).returning();
    return row;
  } catch (err) {
    if (isOverlapViolation(err)) throw new BookingError('slot_taken', 'Someone just took that time. Please pick another.', 409);
    throw err;
  }
}

// ─── Confirm ────────────────────────────────────────────────────────────────────

export interface ConfirmInput {
  botId: string;
  holdId: string;
  name: string;
  email: string;
  phone?: string | null;
  answers?: Record<string, unknown>;
  conversationId?: string | null;
  actor?: Actor;
}

export function validateAnswers(questions: IntakeQuestion[], raw: Record<string, unknown> | undefined): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const v = raw?.[q.id] ?? raw?.[q.label];
    const text = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
    const trimmed = text.trim().slice(0, 1000);
    if (!trimmed && q.required) throw new BookingError('missing_fields', `Please answer: ${q.label}`);
    if (trimmed) answers[q.id] = trimmed;
  }
  return answers;
}

export async function upsertPerson(
  tx: Tx | typeof db,
  p: { botId: string; tenantId: string; name?: string | null; email?: string | null; phone?: string | null; timezone?: string | null; source: string },
) {
  const emailNorm = p.email ? normalizeEmail(p.email) : null;
  const phoneNorm = normalizePhone(p.phone);
  if (emailNorm) {
    const [row] = await tx.insert(bookingPeople).values({
      botId: p.botId, tenantId: p.tenantId, emailNorm, phoneNorm, name: p.name ?? null, email: p.email!.trim(),
      phone: p.phone?.trim() || null, timezone: p.timezone ?? null, source: p.source,
    }).onConflictDoUpdate({
      target: [bookingPeople.botId, bookingPeople.emailNorm],
      targetWhere: sql`${bookingPeople.emailNorm} IS NOT NULL`,
      set: {
        name: sql`COALESCE(NULLIF(${p.name ?? ''}, ''), ${bookingPeople.name})`,
        phone: sql`COALESCE(NULLIF(${p.phone?.trim() ?? ''}, ''), ${bookingPeople.phone})`,
        phoneNorm: sql`COALESCE(${phoneNorm}, ${bookingPeople.phoneNorm})`,
        timezone: sql`COALESCE(${p.timezone ?? null}, ${bookingPeople.timezone})`,
        lastSeenAt: new Date(),
      },
    }).returning();
    return row;
  }
  const [row] = await tx.insert(bookingPeople).values({
    botId: p.botId, tenantId: p.tenantId, phoneNorm, name: p.name ?? null, phone: p.phone?.trim() || null,
    timezone: p.timezone ?? null, source: p.source,
  }).returning();
  return row;
}

/** Queue the emails/jobs that follow a booking becoming confirmed (or pending approval). */
async function queueAfterBooking(tx: Tx, b: Booking, settings: BookingSettings, status: 'confirmed' | 'pending') {
  const botId = b.botId;
  if (status === 'pending') {
    if (notifyOn(settings, 'visitorConfirmation')) await enqueueEmail(tx, { template: 'visitor.request_received', bookingId: b.id, botId });
    await enqueueEmail(tx, { template: 'owner.approval_needed', bookingId: b.id, botId, runAt: addMinutes(new Date(), 0.15) });
  } else {
    if (notifyOn(settings, 'visitorConfirmation')) await enqueueEmail(tx, { template: 'visitor.confirmed', bookingId: b.id, botId });
    // The owner email waits a few seconds so the AI conversation summary can be attached.
    if (notifyOn(settings, 'ownerNewBooking')) await enqueueEmail(tx, { template: 'owner.new_booking', bookingId: b.id, botId, runAt: addMinutes(new Date(), 0.15) });
    await scheduleReminders(tx, b, settings);
  }
  if (b.conversationId) await enqueueJob(tx, { kind: 'summary', bookingId: b.id, botId });
}

async function scheduleReminders(tx: Tx, b: Booking, settings: BookingSettings) {
  const now = Date.now();
  const at = (minutesBefore: number) => addMinutes(b.startsAt, -minutesBefore);
  if (notifyOn(settings, 'reminder24h') && at(24 * 60).getTime() > now + 60_000) {
    await enqueueEmail(tx, { template: 'visitor.reminder_24h', bookingId: b.id, botId: b.botId, runAt: at(24 * 60) });
  }
  if (notifyOn(settings, 'reminder1h') && at(60).getTime() > now + 60_000) {
    await enqueueEmail(tx, { template: 'visitor.reminder_1h', bookingId: b.id, botId: b.botId, runAt: at(60) });
  }
  if (notifyOn(settings, 'followUp')) {
    const hours = settings.notify?.followUpHours ?? 2;
    await enqueueEmail(tx, { template: 'visitor.follow_up', bookingId: b.id, botId: b.botId, runAt: addMinutes(b.endsAt, hours * 60) });
  }
}

const SCHEDULED_TEMPLATES = ['visitor.reminder_24h', 'visitor.reminder_1h', 'visitor.follow_up'];

export interface ConfirmResult { booking: Booking; manageToken: string }

export async function confirmBooking(input: ConfirmInput): Promise<ConfirmResult> {
  const name = input.name?.trim();
  const email = input.email?.trim();
  if (!name) throw new BookingError('missing_fields', 'Please share your name.');
  if (!email || !EMAIL_RE.test(email)) throw new BookingError('missing_fields', 'Please share a valid email address.');

  return db.transaction(async (tx) => {
    const [held] = await tx.select().from(bookings)
      .where(and(eq(bookings.id, input.holdId), eq(bookings.botId, input.botId)))
      .for('update');
    if (!held) throw new BookingError('not_found', 'That booking hold was not found.', 404);
    if (input.conversationId && held.conversationId && held.conversationId !== input.conversationId) {
      throw new BookingError('forbidden', 'That booking hold belongs to another conversation.', 403);
    }

    const settings = await ensureSettings({ id: held.botId, tenantId: held.tenantId });
    if (!settings.enabled) throw new BookingError('disabled', 'Booking is not enabled for this bot.', 403);
    const type = held.meetingTypeId ? await getMeetingType(held.botId, held.meetingTypeId) : undefined;
    if (!type) throw new BookingError('not_found', 'That meeting type no longer exists.', 404);

    // Idempotent: a retry after success returns the existing booking.
    if (held.status === 'confirmed' || held.status === 'pending') {
      if (held.visitorEmail && normalizeEmail(held.visitorEmail) === normalizeEmail(email)) {
        return { booking: held, manageToken: signManageToken(held.id) };
      }
      throw new BookingError('invalid_state', 'This booking was already completed.', 409);
    }
    if (held.status !== 'held' && held.status !== 'expired') throw new BookingError('invalid_state', 'This time can no longer be booked.', 409);

    if (settings.requirePhone && !input.phone?.trim()) throw new BookingError('missing_fields', 'Please share a phone number.');
    const answers = validateAnswers(type.questions, input.answers);

    // An expired hold may be revived only if nobody took the slot meanwhile (the constraint decides).
    const status = type.confirmation === 'approval' ? 'pending' : 'confirmed';
    const person = await upsertPerson(tx, {
      botId: held.botId, tenantId: held.tenantId, name, email, phone: input.phone ?? null,
      timezone: held.visitorTz, source: held.source,
    });
    let updated: Booking;
    try {
      [updated] = await tx.update(bookings).set({
        status, holdExpiresAt: null, personId: person.id,
        visitorName: name, visitorEmail: email, visitorPhone: input.phone?.trim() || null,
        answers, updatedAt: new Date(),
      }).where(eq(bookings.id, held.id)).returning();
    } catch (err) {
      if (isOverlapViolation(err)) throw new BookingError('slot_taken', 'Someone just took that time. Please pick another.', 409);
      throw err;
    }

    await logEvent(tx, updated, status === 'pending' ? 'requested' : 'created', input.actor ?? 'visitor', { source: held.source });
    await queueAfterBooking(tx, updated, settings, status);
    return { booking: updated, manageToken: signManageToken(updated.id) };
  });
}

// ─── Manual booking (owner) ─────────────────────────────────────────────────────

export interface ManualInput {
  botId: string; tenantId: string; typeId: string; start: Date; name: string; email: string;
  phone?: string | null; answers?: Record<string, unknown>; notify?: boolean; actorUserId?: string;
  /** Owners may book outside their normal hours; the no-overlap rule still applies. */
  ignoreHours?: boolean;
}

export async function createManualBooking(input: ManualInput): Promise<ConfirmResult> {
  const settings = await ensureSettings({ id: input.botId, tenantId: input.tenantId });
  const type = await getMeetingType(input.botId, input.typeId);
  if (!type) throw new BookingError('not_found', 'That meeting type does not exist.', 404);
  const email = input.email.trim();
  if (!input.name.trim() || !EMAIL_RE.test(email)) throw new BookingError('missing_fields', 'A name and a valid email are required.');

  if (!input.ignoreHours) {
    const ctx = await loadEngineContext(settings, type, input.start, input.start, { ignoreNotice: true }); // owners may book inside the notice period
    if (!isSlotOffered(ctx, input.start)) throw new BookingError('slot_unavailable', 'That time is outside your availability.', 409);
  }
  const end = addMinutes(input.start, type.durationMin);

  return db.transaction(async (tx) => {
    const person = await upsertPerson(tx, {
      botId: input.botId, tenantId: input.tenantId, name: input.name.trim(), email, phone: input.phone ?? null,
      timezone: settings.timezone, source: 'manual',
    });
    let row: Booking;
    try {
      [row] = await tx.insert(bookings).values({
        botId: input.botId, tenantId: input.tenantId, meetingTypeId: type.id, personId: person.id,
        status: 'confirmed', startsAt: input.start, endsAt: end, ...blockRange(input.start, end, type),
        typeName: type.name, visitorName: input.name.trim(), visitorEmail: email, visitorPhone: input.phone?.trim() || null,
        visitorTz: settings.timezone, answers: validateAnswers(type.questions.map((q) => ({ ...q, required: false })), input.answers),
        source: 'manual', locationSnapshot: { type: type.locationType, value: type.locationValue },
        icsUid: `${crypto.randomUUID()}@cloudgeniee.com`,
      }).returning();
    } catch (err) {
      if (isOverlapViolation(err)) throw new BookingError('slot_taken', 'That time overlaps another booking.', 409);
      throw err;
    }
    await logEvent(tx, row, 'created', 'owner', { source: 'manual' }, input.actorUserId);
    if (input.notify !== false) {
      await enqueueEmail(tx, { template: 'visitor.confirmed', bookingId: row.id, botId: row.botId });
      await scheduleReminders(tx, row, settings);
    }
    return { booking: row, manageToken: signManageToken(row.id) };
  });
}

// ─── Reschedule / cancel / approve / decline / outcome ──────────────────────────

async function lockBooking(tx: Tx, botId: string, id: string): Promise<Booking> {
  const [b] = await tx.select().from(bookings).where(and(eq(bookings.id, id), eq(bookings.botId, botId))).for('update');
  if (!b) throw new BookingError('not_found', 'Booking not found.', 404);
  return b;
}

export interface ChangeOpts { actor: Actor; actorUserId?: string; notify?: boolean; reason?: string | null }

export async function rescheduleBooking(botId: string, bookingId: string, newStart: Date, opts: ChangeOpts & { ignoreHours?: boolean }): Promise<Booking> {
  return db.transaction(async (tx) => {
    const b = await lockBooking(tx, botId, bookingId);
    if (b.status !== 'confirmed' && b.status !== 'pending') throw new BookingError('invalid_state', 'Only upcoming bookings can be moved.', 409);
    const settings = await ensureSettings({ id: b.botId, tenantId: b.tenantId });
    const type = b.meetingTypeId ? await getMeetingType(b.botId, b.meetingTypeId) : undefined;
    if (!type) throw new BookingError('not_found', 'That meeting type no longer exists.', 404);

    if (!opts.ignoreHours) {
      const ctx = await loadEngineContext(settings, type, newStart, newStart, {
        excludeBookingId: b.id, client: tx,
        ignoreNotice: opts.actor === 'owner',
      });
      if (!isSlotOffered(ctx, newStart)) throw new BookingError('slot_unavailable', 'That time is not available.', 409);
    }

    const end = addMinutes(newStart, type.durationMin);
    let updated: Booking;
    try {
      [updated] = await tx.update(bookings).set({
        startsAt: newStart, endsAt: end, ...blockRange(newStart, end, type),
        icsSequence: sql`${bookings.icsSequence} + 1`, updatedAt: new Date(),
      }).where(eq(bookings.id, b.id)).returning();
    } catch (err) {
      if (isOverlapViolation(err)) throw new BookingError('slot_taken', 'That time overlaps another booking.', 409);
      throw err;
    }

    await logEvent(tx, updated, 'rescheduled', opts.actor, { from: b.startsAt, to: newStart, reason: opts.reason ?? null }, opts.actorUserId);
    await cancelScheduledEmails(tx, b.id, SCHEDULED_TEMPLATES);
    if (updated.status === 'confirmed') await scheduleReminders(tx, updated, settings);
    if (opts.notify !== false && notifyOn(settings, 'visitorChanges')) {
      await enqueueEmail(tx, { template: 'visitor.rescheduled', bookingId: b.id, botId: b.botId });
    }
    if (opts.actor !== 'owner' && notifyOn(settings, 'ownerChanges')) {
      await enqueueEmail(tx, { template: 'owner.rescheduled', bookingId: b.id, botId: b.botId });
    }
    return updated;
  });
}

export async function cancelBooking(botId: string, bookingId: string, opts: ChangeOpts): Promise<Booking> {
  return db.transaction(async (tx) => {
    const b = await lockBooking(tx, botId, bookingId);
    if (b.status === 'cancelled') return b;
    if (b.status !== 'confirmed' && b.status !== 'pending' && b.status !== 'held') {
      throw new BookingError('invalid_state', 'This booking can no longer be cancelled.', 409);
    }
    const settings = await ensureSettings({ id: b.botId, tenantId: b.tenantId });
    const [updated] = await tx.update(bookings).set({
      status: 'cancelled', cancelReason: opts.reason?.trim() || null, cancelledBy: opts.actor, holdExpiresAt: null,
      icsSequence: sql`${bookings.icsSequence} + 1`, updatedAt: new Date(),
    }).where(eq(bookings.id, b.id)).returning();

    await logEvent(tx, updated, 'cancelled', opts.actor, { reason: opts.reason ?? null }, opts.actorUserId);
    await cancelScheduledEmails(tx, b.id, [...SCHEDULED_TEMPLATES, 'owner.new_booking', 'owner.approval_needed']);
    if (b.status !== 'held') {
      if (opts.notify !== false && notifyOn(settings, 'visitorChanges')) {
        await enqueueEmail(tx, { template: 'visitor.cancelled', bookingId: b.id, botId: b.botId });
      }
      if (opts.actor !== 'owner' && notifyOn(settings, 'ownerChanges')) {
        await enqueueEmail(tx, { template: 'owner.cancelled', bookingId: b.id, botId: b.botId });
      }
    }
    return updated;
  });
}

export async function approveBooking(botId: string, bookingId: string, opts: { actor: Actor; actorUserId?: string }): Promise<Booking> {
  return db.transaction(async (tx) => {
    const b = await lockBooking(tx, botId, bookingId);
    if (b.status === 'confirmed') return b;
    if (b.status !== 'pending') throw new BookingError('invalid_state', 'This request was already handled.', 409);
    const settings = await ensureSettings({ id: b.botId, tenantId: b.tenantId });
    const [updated] = await tx.update(bookings).set({ status: 'confirmed', updatedAt: new Date() }).where(eq(bookings.id, b.id)).returning();
    await logEvent(tx, updated, 'approved', opts.actor, {}, opts.actorUserId);
    await enqueueEmail(tx, { template: 'visitor.approved', bookingId: b.id, botId: b.botId });
    await scheduleReminders(tx, updated, settings);
    return updated;
  });
}

export async function declineBooking(botId: string, bookingId: string, opts: { actor: Actor; actorUserId?: string; reason?: string | null }): Promise<Booking> {
  return db.transaction(async (tx) => {
    const b = await lockBooking(tx, botId, bookingId);
    if (b.status === 'declined') return b;
    if (b.status !== 'pending') throw new BookingError('invalid_state', 'This request was already handled.', 409);
    const [updated] = await tx.update(bookings).set({
      status: 'declined', cancelReason: opts.reason?.trim() || null, cancelledBy: opts.actor, updatedAt: new Date(),
    }).where(eq(bookings.id, b.id)).returning();
    await logEvent(tx, updated, 'declined', opts.actor, { reason: opts.reason ?? null }, opts.actorUserId);
    await cancelScheduledEmails(tx, b.id, ['owner.approval_needed']);
    await enqueueEmail(tx, { template: 'visitor.declined', bookingId: b.id, botId: b.botId });
    return updated;
  });
}

export async function markOutcome(
  botId: string, bookingId: string, outcome: 'completed' | 'no_show' | 'confirmed', opts: { actorUserId?: string; note?: string | null },
): Promise<Booking> {
  return db.transaction(async (tx) => {
    const b = await lockBooking(tx, botId, bookingId);
    if (!['confirmed', 'completed', 'no_show'].includes(b.status)) throw new BookingError('invalid_state', 'Only confirmed bookings can be marked.', 409);
    const [updated] = await tx.update(bookings).set({
      status: outcome, outcomeNote: opts.note?.trim() || b.outcomeNote, updatedAt: new Date(),
    }).where(eq(bookings.id, b.id)).returning();
    await logEvent(tx, updated, outcome === 'confirmed' ? 'outcome_cleared' : outcome, 'owner', { note: opts.note ?? null }, opts.actorUserId);
    return updated;
  });
}

// ─── Notes & tags ───────────────────────────────────────────────────────────────

export async function addNote(botId: string, input: { bookingId?: string; personId?: string; body: string; userId?: string; userName?: string }) {
  const body = input.body.trim();
  if (!body) throw new BookingError('missing_fields', 'Write something first.');
  let personId = input.personId;
  if (input.bookingId) {
    const [b] = await db.select({ id: bookings.id, personId: bookings.personId }).from(bookings)
      .where(and(eq(bookings.id, input.bookingId), eq(bookings.botId, botId))).limit(1);
    if (!b) throw new BookingError('not_found', 'Booking not found.', 404);
    personId = personId ?? b.personId ?? undefined;
  }
  const [note] = await db.insert(bookingNotes).values({
    botId, bookingId: input.bookingId, personId, body: body.slice(0, 4000), authorUserId: input.userId, authorName: input.userName,
  }).returning();
  if (input.bookingId) await logEvent(db, { id: input.bookingId, botId }, 'note', 'owner', { noteId: note.id }, input.userId);
  return note;
}

export async function setBookingTags(botId: string, bookingId: string, tags: string[]) {
  const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  const [row] = await db.update(bookings).set({ tags: clean, updatedAt: new Date() })
    .where(and(eq(bookings.id, bookingId), eq(bookings.botId, botId))).returning({ id: bookings.id, tags: bookings.tags });
  if (!row) throw new BookingError('not_found', 'Booking not found.', 404);
  return row;
}

export async function setPersonTags(botId: string, personId: string, tags: string[]) {
  const clean = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  const [row] = await db.update(bookingPeople).set({ tags: clean })
    .where(and(eq(bookingPeople.id, personId), eq(bookingPeople.botId, botId))).returning({ id: bookingPeople.id, tags: bookingPeople.tags });
  if (!row) throw new BookingError('not_found', 'Person not found.', 404);
  return row;
}

// ─── Lookups used by several callers ────────────────────────────────────────────

export async function getBookingByManageToken(token: string): Promise<Booking | undefined> {
  const id = verifyManageToken(token);
  if (!id) return undefined;
  const [row] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
  return row;
}

/** Upcoming + recent bookings of an email for one bot (used after OTP verification). */
export async function bookingsForEmail(botId: string, email: string): Promise<Booking[]> {
  return db.select().from(bookings).where(and(
    eq(bookings.botId, botId),
    sql`lower(${bookings.visitorEmail}) = ${normalizeEmail(email)}`,
    inArray(bookings.status, ['confirmed', 'pending']),
    sql`${bookings.endsAt} > now()`,
  )).orderBy(bookings.startsAt);
}

export async function typesForBot(botId: string) {
  return listActiveTypes(botId);
}
