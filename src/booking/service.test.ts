import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { bookingJobs, bookings } from './schema.js';
import { conversations, db } from '../db/index.js';
import {
  approveBooking, cancelBooking, confirmBooking, createManualBooking, declineBooking, holdSlot, listSlots,
  markOutcome, rescheduleBooking,
} from './service.js';
import { BookingError, expireStaleHolds } from './core.js';
import { futureSlot, seedBot } from './test-utils.js';
import { getOverview, listBookings, listPeople, viewCounts } from './queries.js';
import { hasFeature } from './entitlements.js';
import { processEmailJob } from './notify/notifier.js';
import { setMailer, type OutgoingMail } from './notify/mailer.js';
import { requestOtp, verifyOtp } from './otp.js';
import { signManageToken, verifyManageToken } from './tokens.js';

const jobsFor = (bookingId: string) => db.select().from(bookingJobs).where(eq(bookingJobs.bookingId, bookingId));
const templates = async (bookingId: string, includeDone = true) =>
  (await jobsFor(bookingId)).filter((j) => includeDone || !j.doneAt).map((j) => String((j.payload as { template?: string }).template ?? j.kind)).sort();
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof BookingError ? e.code : `error:${(e as Error).message}`));

describe('booking lifecycle', () => {
  it('hold → confirm creates a confirmed booking with its emails and reminders queued', async () => {
    const { bot, type } = await seedBot();
    const start = futureSlot(10);
    const hold = await holdSlot({ botId: bot.id, typeId: type.id, start, visitorTz: 'Asia/Karachi' });
    expect(hold.status).toBe('held');

    const { booking, manageToken } = await confirmBooking({ botId: bot.id, holdId: hold.id, name: 'Sara Khan', email: 'Sara@Example.com', phone: '+15550100' });
    expect(booking.status).toBe('confirmed');
    expect(booking.holdExpiresAt).toBeNull();
    expect(verifyManageToken(manageToken)).toBe(booking.id);

    expect(await templates(booking.id)).toEqual(['owner.new_booking', 'visitor.confirmed', 'visitor.reminder_1h', 'visitor.reminder_24h']);

    const { slots } = await listSlots({ botId: bot.id, typeId: type.id, from: new Date(start.getTime() - 3600_000), to: new Date(start.getTime() + 3600_000) });
    expect(slots.some((s) => s.start.getTime() === start.getTime())).toBe(false);
  });

  it('confirm is idempotent for the same email and rejects another', async () => {
    const { bot, type } = await seedBot();
    const hold = await holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(11) });
    const first = await confirmBooking({ botId: bot.id, holdId: hold.id, name: 'A', email: 'a@x.com' });
    const again = await confirmBooking({ botId: bot.id, holdId: hold.id, name: 'A', email: 'a@x.com' });
    expect(again.booking.id).toBe(first.booking.id);
    expect(await code(confirmBooking({ botId: bot.id, holdId: hold.id, name: 'B', email: 'b@x.com' }))).toBe('invalid_state');
    expect((await templates(first.booking.id)).filter((t) => t === 'visitor.confirmed')).toHaveLength(1);
  });

  it('twenty concurrent holds for one slot → exactly one wins', async () => {
    const { bot, type } = await seedBot();
    const start = futureSlot(14);
    const results = await Promise.all(Array.from({ length: 20 }, () => code(holdSlot({ botId: bot.id, typeId: type.id, start }))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'slot_taken' || r === 'slot_unavailable')).toHaveLength(19);
  });

  it('rejects times outside working hours, off-grid times, and past times', async () => {
    const { bot, type } = await seedBot();
    expect(await code(holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(20) }))).toBe('slot_unavailable');
    expect(await code(holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(10, 15) }))).toBe('slot_unavailable');
    expect(await code(holdSlot({ botId: bot.id, typeId: type.id, start: new Date(Date.now() - 86400_000) }))).toBe('slot_unavailable');
  });

  it('an expired hold frees the slot again', async () => {
    const { bot, type } = await seedBot();
    const start = futureSlot(15);
    const hold = await holdSlot({ botId: bot.id, typeId: type.id, start });
    expect(await code(holdSlot({ botId: bot.id, typeId: type.id, start }))).toBe('slot_unavailable');
    await db.update(bookings).set({ holdExpiresAt: new Date(Date.now() - 1000) }).where(eq(bookings.id, hold.id));
    expect(await expireStaleHolds(bot.id)).toBe(1);
    expect(await code(holdSlot({ botId: bot.id, typeId: type.id, start }))).toBe('ok');
  });

  it('a new hold in the same conversation replaces the previous one', async () => {
    const { bot, type } = await seedBot();
    const [conv] = await db.insert(conversations).values({ botId: bot.id, tenantId: bot.tenantId }).returning({ id: conversations.id });
    const h1 = await holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(10), conversationId: conv.id });
    const h2 = await holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(11), conversationId: conv.id });
    const [old] = await db.select().from(bookings).where(eq(bookings.id, h1.id));
    expect(old.status).toBe('expired');
    expect(h2.status).toBe('held');
  });

  it('validates required intake answers and details', async () => {
    const { bot, type } = await seedBot({ questions: [{ id: 'first', label: 'Is this your first visit?', type: 'yes_no', required: true }] });
    const hold = await holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(10) });
    expect(await code(confirmBooking({ botId: bot.id, holdId: hold.id, name: 'A', email: 'a@x.com' }))).toBe('missing_fields');
    expect(await code(confirmBooking({ botId: bot.id, holdId: hold.id, name: 'A', email: 'not-an-email' }))).toBe('missing_fields');
    const ok = await confirmBooking({ botId: bot.id, holdId: hold.id, name: 'A', email: 'a@x.com', answers: { first: 'Yes' } });
    expect(ok.booking.answers).toEqual({ first: 'Yes' });
  });

  it('reschedule bumps the invite sequence and replaces reminders', async () => {
    const { bot, type } = await seedBot();
    const hold = await holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(10, 0, 10) });
    const { booking } = await confirmBooking({ botId: bot.id, holdId: hold.id, name: 'A', email: 'a@x.com' });

    const moved = await rescheduleBooking(bot.id, booking.id, futureSlot(15, 0, 12), { actor: 'visitor' });
    expect(moved.icsSequence).toBe(1);
    expect(moved.startsAt.getTime()).toBe(futureSlot(15, 0, 12).getTime());

    const live = await templates(booking.id, false);
    expect(live.filter((t) => t === 'visitor.reminder_24h')).toHaveLength(1);
    expect(live).toContain('visitor.rescheduled');
    expect(live).toContain('owner.rescheduled'); // a visitor-initiated change alerts the owner

    const other = await holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(16, 0, 12) });
    await confirmBooking({ botId: bot.id, holdId: other.id, name: 'B', email: 'b@x.com' });
    expect(await code(rescheduleBooking(bot.id, booking.id, futureSlot(16, 0, 12), { actor: 'visitor' }))).toBe('slot_unavailable');
  });

  it('cancel frees the slot, cancels scheduled emails and notifies', async () => {
    const { bot, type } = await seedBot();
    const start = futureSlot(10, 0, 9);
    const hold = await holdSlot({ botId: bot.id, typeId: type.id, start });
    const { booking } = await confirmBooking({ botId: bot.id, holdId: hold.id, name: 'A', email: 'a@x.com' });
    const cancelled = await cancelBooking(bot.id, booking.id, { actor: 'visitor', reason: 'Plans changed' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('Plans changed');
    const live = await templates(booking.id, false);
    expect(live).toContain('visitor.cancelled');
    expect(live).toContain('owner.cancelled');
    expect(live).not.toContain('visitor.reminder_24h');
    expect(await code(holdSlot({ botId: bot.id, typeId: type.id, start }))).toBe('ok');
  });

  it('approval mode: pending → approve / decline', async () => {
    const { bot, type } = await seedBot({ confirmation: 'approval' });
    const h1 = await holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(10, 0, 8) });
    const { booking: pending } = await confirmBooking({ botId: bot.id, holdId: h1.id, name: 'A', email: 'a@x.com' });
    expect(pending.status).toBe('pending');
    expect(await templates(pending.id)).toEqual(expect.arrayContaining(['owner.approval_needed', 'visitor.request_received']));
    expect(await code(holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(10, 0, 8) }))).toBe('slot_unavailable');
    expect((await approveBooking(bot.id, pending.id, { actor: 'owner' })).status).toBe('confirmed');
    expect(await templates(pending.id)).toContain('visitor.approved');

    const h2 = await holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(11, 0, 8) });
    const { booking: second } = await confirmBooking({ botId: bot.id, holdId: h2.id, name: 'B', email: 'b@x.com' });
    expect((await declineBooking(bot.id, second.id, { actor: 'owner', reason: 'Fully booked' })).status).toBe('declined');
    expect(await code(holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(11, 0, 8) }))).toBe('ok');
    expect(await code(approveBooking(bot.id, second.id, { actor: 'owner' }))).toBe('invalid_state');
  });

  it('owner can book manually and mark outcomes', async () => {
    const { bot, tenant, type } = await seedBot();
    const { booking } = await createManualBooking({ botId: bot.id, tenantId: tenant.id, typeId: type.id, start: futureSlot(9, 30, 5), name: 'Walk In', email: 'w@x.com' });
    expect(booking.source).toBe('manual');
    expect((await markOutcome(bot.id, booking.id, 'completed', {})).status).toBe('completed');
    expect((await markOutcome(bot.id, booking.id, 'no_show', { note: 'Did not show' })).status).toBe('no_show');
  });

  it('tenant isolation: another bot cannot touch a booking', async () => {
    const a = await seedBot();
    const b = await seedBot();
    const hold = await holdSlot({ botId: a.bot.id, typeId: a.type.id, start: futureSlot(10) });
    const { booking } = await confirmBooking({ botId: a.bot.id, holdId: hold.id, name: 'A', email: 'a@x.com' });
    expect(await code(cancelBooking(b.bot.id, booking.id, { actor: 'owner' }))).toBe('not_found');
    expect(await code(confirmBooking({ botId: b.bot.id, holdId: hold.id, name: 'A', email: 'a@x.com' }))).toBe('not_found');
  });
});

describe('queries', () => {
  it('lists views, counts, people and an overview', async () => {
    const { bot, type } = await seedBot();
    const settings = { timezone: 'UTC' };
    for (const [i, email] of ['a@x.com', 'b@x.com', 'a@x.com'].entries()) {
      const h = await holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(9 + i, 0, 6) });
      await confirmBooking({ botId: bot.id, holdId: h.id, name: email[0].toUpperCase(), email });
    }
    const upcoming = await listBookings(bot.id, settings, { view: 'upcoming' });
    expect(upcoming.total).toBe(3);
    expect(upcoming.rows[0].startsAt <= upcoming.rows[1].startsAt).toBe(true);
    expect((await listBookings(bot.id, settings, { view: 'upcoming', q: 'b@x' })).total).toBe(1);
    expect((await viewCounts(bot.id, settings)).upcoming).toBe(3);

    const people = await listPeople(bot.id, {});
    expect(people.total).toBe(2); // a@x.com booked twice → one person
    expect(people.rows.find((p) => p.email === 'a@x.com')?.bookingsCount).toBe(2);
    expect((await listPeople(bot.id, { segment: 'returning' })).total).toBe(1);

    const overview = await getOverview(bot.id, settings, 30);
    expect(overview.kpis.upcoming).toBe(3);
    expect(overview.trend).toHaveLength(30);
    expect(overview.trend.reduce((n, d) => n + d.count, 0)).toBe(3);
    expect(overview.nextUp?.id).toBeTruthy();
  });
});

describe('entitlements and tokens', () => {
  it('plan default, tenant override and kill switch', () => {
    expect(hasFeature({ plan: 'starter', featureOverrides: {} }, 'booking')).toBe(false);
    expect(hasFeature({ plan: 'growth', featureOverrides: {} }, 'booking')).toBe(true);
    expect(hasFeature({ plan: 'enterprise', featureOverrides: {} }, 'booking')).toBe(true);
    expect(hasFeature({ plan: 'starter', featureOverrides: { booking: true } }, 'booking')).toBe(true);
    expect(hasFeature({ plan: 'growth', featureOverrides: { booking: false } }, 'booking')).toBe(false);
    process.env.FEATURE_BOOKING = 'false';
    expect(hasFeature({ plan: 'enterprise', featureOverrides: { booking: true } }, 'booking')).toBe(false);
    delete process.env.FEATURE_BOOKING;
  });

  it('manage tokens cannot be forged', () => {
    const id = crypto.randomUUID();
    const t = signManageToken(id);
    expect(verifyManageToken(t)).toBe(id);
    expect(verifyManageToken(t.slice(0, -2) + 'xx')).toBeNull();
    expect(verifyManageToken(`${crypto.randomUUID()}.${t.split('.')[1]}`)).toBeNull();
  });
});

describe('emails', () => {
  const sent: OutgoingMail[] = [];
  beforeAll(() => setMailer({ send: async (m) => { sent.push(m); return { id: 'test' }; } }));

  it('renders and sends the visitor confirmation with an invite, then skips after cancel', async () => {
    const { bot, type, ownerEmail } = await seedBot();
    sent.length = 0;
    const hold = await holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(10, 0, 9), visitorTz: 'America/New_York' });
    const { booking } = await confirmBooking({ botId: bot.id, holdId: hold.id, name: 'Sara <b>Khan</b>', email: 'sara@example.com' });

    const jobs = await jobsFor(booking.id);
    const run = (template: string) =>
      processEmailJob({ id: jobs.find((j) => (j.payload as { template: string }).template === template)!.id, bookingId: booking.id, payload: { template } });

    expect(await run('visitor.confirmed')).toBe('sent');
    const mail = sent.at(-1)!;
    expect(mail.to).toBe('sara@example.com');
    expect(mail.from.name).toContain(' via ChatGeniee');
    expect(mail.replyTo).toBe(ownerEmail);
    expect(mail.ical?.method).toBe('REQUEST');
    expect(mail.ical?.content).toContain('BEGIN:VEVENT');
    expect(mail.ical?.content).toContain(`UID:${booking.icsUid}`);
    expect(mail.html).toContain('https://book.test/m/');
    expect(mail.html).not.toContain('<b>Khan</b>'); // visitor-supplied HTML is escaped
    expect(mail.subject).toContain('Confirmed: Consultation');

    expect(await run('owner.new_booking')).toBe('sent');
    const ownerMail = sent.at(-1)!;
    expect(ownerMail.to).toBe(ownerEmail);
    expect(ownerMail.html).toContain('View in ChatGeniee');
    expect(ownerMail.ical?.method).toBe('PUBLISH');

    await cancelBooking(bot.id, booking.id, { actor: 'visitor' });
    expect(await run('visitor.reminder_24h')).toBe('skipped'); // cancelled → no reminder
  });
});

describe('otp', () => {
  const sent: OutgoingMail[] = [];
  beforeAll(() => setMailer({ send: async (m) => { sent.push(m); return { id: 'test' }; } }));

  it('only emails a code when bookings exist, and locks after five wrong tries', async () => {
    const { bot, type } = await seedBot();
    sent.length = 0;
    await requestOtp(bot.id, 'nobody@example.com');
    expect(sent).toHaveLength(0); // silent — no enumeration

    const hold = await holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(10, 0, 7) });
    await confirmBooking({ botId: bot.id, holdId: hold.id, name: 'A', email: 'a@x.com' });
    await requestOtp(bot.id, 'A@x.com');
    expect(sent).toHaveLength(1);
    const real = sent[0].subject.match(/^(\d{6}) is your/)![1];

    for (let i = 0; i < 5; i++) expect(await verifyOtp(bot.id, 'a@x.com', '000000')).toBe(false);
    expect(await verifyOtp(bot.id, 'a@x.com', real)).toBe(false); // locked out even with the right code
  });

  it('accepts the right code once and rate-limits requests', async () => {
    const { bot, type } = await seedBot();
    sent.length = 0;
    const hold = await holdSlot({ botId: bot.id, typeId: type.id, start: futureSlot(11, 0, 7) });
    await confirmBooking({ botId: bot.id, holdId: hold.id, name: 'A', email: 'a@x.com' });
    await requestOtp(bot.id, 'a@x.com');
    const real = sent[0].subject.match(/^(\d{6}) is your/)![1];
    expect(await verifyOtp(bot.id, 'a@x.com', real)).toBe(true);
    expect(await verifyOtp(bot.id, 'a@x.com', real)).toBe(false); // single use
    await requestOtp(bot.id, 'a@x.com');
    await requestOtp(bot.id, 'a@x.com');
    expect(await code(requestOtp(bot.id, 'a@x.com'))).toBe('rate_limited');
  });
});
