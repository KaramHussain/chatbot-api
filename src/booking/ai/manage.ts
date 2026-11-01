// Server-driven "change or cancel my booking" flow. Like booking itself, this must not depend on a model
// remembering to call tools (it will happily say "I've sent you a code" without doing it), so the server:
//   • sends the verification code when the visitor asks to cancel / reschedule,
//   • checks the 6-digit code when they type it,
//   • cancels (after a yes) or reschedules (on a tapped time) directly.
// The model only phrases the reply, guided by a short note describing what just happened.
import { eq, sql } from 'drizzle-orm';
import { conversations, db } from '../../db/index.js';
import { bookingsForEmail } from '../service.js';
import { verifiedEmailOf } from '../otp.js';
import { formatDateTime, zoneAbbreviation } from '../time.js';
import { savedDetails, type ToolRunner } from './tools.js';
import type { Booking } from '../core.js';

interface ManageState { email?: string; codeSent?: boolean; awaitEmail?: boolean; pendingCancel?: string; rescheduleFor?: string }

export interface ManageResult { note: string; allowTools?: boolean }

const CANCEL = /\bcancel\w*\b/i;
const RESCHEDULE = /\b(re-?schedul\w*|move (it|my|the|this)|change (my|the|this) (booking|appointment|meeting|time|slot|date)|different (day|date))\b/i;
const YES = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|confirm(ed)?|do it|go ahead|please do|cancel it|that'?s right|correct)\b/i;
const NO = /^\s*(no|nope|nah|don'?t|do not|keep it|never ?mind|leave it)\b/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
const CODE = /(?<!\d)(\d{6})(?!\d)/;

const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, (_m, a, d) => `${a}***${d}`);

async function load(conversationId: string): Promise<ManageState> {
  const [c] = await db.select({ lead: conversations.leadData }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  return ((c?.lead as { manage?: ManageState } | undefined)?.manage) ?? {};
}

async function save(conversationId: string, state: ManageState) {
  await db.update(conversations)
    .set({ leadData: sql`jsonb_set(coalesce(${conversations.leadData}, '{}'::jsonb), '{manage}', ${JSON.stringify(state)}::jsonb)` })
    .where(eq(conversations.id, conversationId));
}

export interface ManageInput {
  botId: string;
  conversationId: string;
  visitorTz: string;
  timeFormat: '12h' | '24h';
  message: string;
  pickSlot?: { start: string; typeName?: string };
  /** A booking is being made right now — "cancel" then most likely means abandoning it, not a past booking. */
  holdActive: boolean;
}

/** Returns a note when the server handled this turn's manage step, otherwise undefined. */
export async function handleManageTurn(input: ManageInput, run: ToolRunner): Promise<ManageResult | undefined> {
  const { conversationId, message } = input;
  const state = await load(conversationId);
  const verified = await verifiedEmailOf(conversationId);
  const label = (b: Booking) => `${b.typeName ?? 'booking'} on ${formatDateTime(b.startsAt, input.visitorTz, input.timeFormat)} ${zoneAbbreviation(b.startsAt, input.visitorTz)}`;

  const sendCode = async (email: string): Promise<ManageResult> => {
    const r = (await run('send_verification_code', { email })) as { error?: string };
    if (r.error) return { note: `[Could not send a code: ${r.error}. Apologise briefly; they can try again in a while.]` };
    await save(conversationId, { ...state, email, codeSent: true, awaitEmail: false });
    return { note: `[A 6-digit verification code was just emailed to ${maskEmail(email)} (if that address has upcoming bookings). Tell the visitor to check their inbox and type the code here. Do NOT reveal or describe any booking yet — not even one you remember from this chat.]` };
  };

  // 1. The visitor typed the code.
  if (!verified && state.codeSent && state.email && CODE.test(message)) {
    const r = (await run('verify_code', { email: state.email, code: CODE.exec(message)![1] })) as { verified?: boolean };
    if (r.verified) {
      await save(conversationId, { ...state, codeSent: false });
      return { note: '[The visitor is now verified. Their upcoming bookings are listed under "Verified bookings". Ask what they would like to do with them: reschedule or cancel.]' };
    }
    return { note: '[That code was wrong or expired. Tell them they can retry the code, or ask for a new one.]' };
  }

  // 2. We asked which email they booked with.
  if (!verified && state.awaitEmail && EMAIL.test(message)) return sendCode(EMAIL.exec(message)![0]);

  // 3. They want to change/cancel but aren't verified yet.
  if (!verified && !input.holdActive && (CANCEL.test(message) || RESCHEDULE.test(message))) {
    const known = (await savedDetails(conversationId)).email;
    if (known) return sendCode(known);
    await save(conversationId, { ...state, awaitEmail: true });
    return { note: '[Ask which email address they booked with (one short question). The system will email them a code once they answer. Do not reveal anything about any booking.]' };
  }

  // 4. Verified: act directly.
  if (verified) {
    const upcoming = await bookingsForEmail(input.botId, verified);

    if (input.pickSlot && state.rescheduleFor) {
      const target = upcoming.find((b) => b.id === state.rescheduleFor);
      await save(conversationId, { ...state, rescheduleFor: undefined });
      if (!target) return { note: '[That booking could not be found any more. Apologise briefly.]' };
      const r = (await run('reschedule_booking', { booking_id: target.id, new_start: input.pickSlot.start })) as { rescheduled?: boolean; when?: string; error?: string };
      return r.rescheduled
        ? { note: `[The ${target.typeName ?? 'booking'} was just moved to ${r.when}. An updated invite was emailed. Confirm in one short sentence. Do not call any tool.]`, allowTools: false }
        : { note: `[Could not move it: ${r.error}. Apologise briefly and offer other times with find_available_slots.]` };
    }

    if (state.pendingCancel) {
      const target = upcoming.find((b) => b.id === state.pendingCancel);
      if (YES.test(message) && target) {
        await save(conversationId, { ...state, pendingCancel: undefined });
        const r = (await run('cancel_booking', { booking_id: target.id })) as { cancelled?: boolean; error?: string };
        return r.cancelled
          ? { note: `[The ${label(target)} booking was just cancelled and a cancellation email was sent. Confirm in one short sentence and offer to book a new time. Do not call any tool.]`, allowTools: false }
          : { note: `[Could not cancel: ${r.error}. Apologise briefly.]` };
      }
      if (NO.test(message)) {
        await save(conversationId, { ...state, pendingCancel: undefined });
        return { note: '[The visitor decided to keep the booking. Acknowledge briefly and ask if there is anything else.]' };
      }
    }

    if (CANCEL.test(message) && !input.holdActive) {
      if (upcoming.length === 1) {
        await save(conversationId, { ...state, pendingCancel: upcoming[0].id });
        return { note: `[Ask the visitor to confirm they want to cancel their ${label(upcoming[0])} booking (yes/no). Nothing is cancelled until they say yes.]` };
      }
      if (!upcoming.length) return { note: '[The verified visitor has no upcoming bookings. Tell them so.]' };
    }

    if (RESCHEDULE.test(message) && !input.holdActive) {
      if (upcoming.length === 1) {
        await save(conversationId, { ...state, rescheduleFor: upcoming[0].id });
        await run('find_available_slots', { meeting_type: upcoming[0].typeName ?? undefined });
        return { note: `[Other times for their ${label(upcoming[0])} booking are now on screen as buttons. Tell them to tap a new time (one short sentence). Do not list the times.]` };
      }
      if (!upcoming.length) return { note: '[The verified visitor has no upcoming bookings. Tell them so.]' };
    }
  }
  return undefined;
}
