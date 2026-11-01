// The booking instructions appended to the bot's system prompt — only when Bookings is on for the bot.
// It carries live state (today's date, the visitor's time zone, an active hold, verified bookings)
// because the model only sees the text of earlier turns, never earlier tool results.
import { DateTime } from 'luxon';
import { eq } from 'drizzle-orm';
import { conversations, db } from '../../db/index.js';
import type { Booking, BookingSettings, MeetingType } from '../core.js';
import { listActiveTypes } from '../core.js';
import { bookingsForEmail } from '../service.js';
import { formatDateTime, formatTime, zoneAbbreviation } from '../time.js';
import { activeHold, missingFor, savedDetails, type SavedDetails } from './tools.js';

export interface GuidanceInput {
  bot: { id: string; name: string; displayName: string | null };
  settings: BookingSettings;
  types: MeetingType[];
  tz: string;
  now: Date;
  hold?: Booking;
  saved: SavedDetails;
  verifiedEmail: string | null;
  upcoming: Booking[];
}

const OFFER: Record<string, string> = {
  request: 'Only start booking when the visitor asks to book, schedule or meet.',
  intent: 'Offer to book once, briefly, when the visitor shows clear interest (asks about pricing, availability, next steps or says they want to talk). If they decline, do not offer again.',
  proactive: 'After answering the visitor\'s first question, offer once to book a time.',
};

const timeFmt = (s: BookingSettings) => (s.timeFormat === '24h' ? '24h' : '12h') as '12h' | '24h';

export function buildBookingGuidance(g: GuidanceInput): string {
  const { settings, tz, now } = g;
  const term = settings.term || 'appointment';
  const today = DateTime.fromJSDate(now, { zone: tz }).toFormat("cccc, d LLLL yyyy, h:mm a");
  const lines: string[] = [];

  lines.push(`\n\n# Booking\nYou can book, reschedule and cancel ${term}s for this business with the booking tools. Today is ${today} (visitor's time zone: ${tz}). Availability comes ONLY from the tools — never state, guess or promise a time yourself.`);

  if (settings.paused) {
    lines.push(`Booking is paused right now. Do not use the booking tools. ${settings.pauseMessage ? `Tell visitors: "${settings.pauseMessage}"` : 'Tell visitors that booking is unavailable at the moment and offer to take their contact details instead.'}`);
    return lines.join('\n');
  }

  lines.push('\n## What can be booked');
  for (const t of g.types) {
    const qs = t.questions.length ? ` Questions: ${t.questions.map((q) => `"${q.label}"${q.required ? ' (required)' : ''}`).join('; ')}.` : '';
    lines.push(`- ${t.name} — ${t.durationMin} min${t.description ? `. ${t.description}` : ''}${t.priceText ? ` Price: ${t.priceText}.` : ''}${t.confirmation === 'approval' ? ' Needs the business\'s approval.' : ''}${qs}`);
  }

  lines.push(`\n## New ${term}
${OFFER[settings.offerMode] ?? OFFER.intent}
1. If there are several meeting types and the visitor has not said which, ask (name the options). With only one, just use it — do not call list_meeting_types.
2. Call find_available_slots IMMEDIATELY — do not ask about preferred days or times first. Use any preference they already mentioned (day, morning/afternoon), otherwise search with no filters. The times appear on screen as tappable buttons, so say one short line like "Here are some times — tap one, or tell me what suits you." NEVER write the individual times in your reply — they are shown as buttons.
3. When they choose a time (they tap one — the message tells you its exact start — or type it), call hold_slot with the exact start. If you don't have an exact start, call find_available_slots again first.
4. Collect what is still missing, ONE question per message, in this order: name, email${settings.requirePhone ? ', phone (required)' : ', phone only if they offer it'}, then the meeting type's questions. Never ask again for anything under "Saved details". Call save_details after each answer.
5. When everything is collected, call present_summary (it shows a confirmation card) and ask them to confirm.
6. Call create_booking ONLY after they clearly say yes or tap Confirm. Then reply in one or two short sentences: it's booked and the invite is on its way to their email. Never claim a booking exists unless create_booking succeeded.
If a tool returns an error (time taken, expired hold…), apologise in a few words and offer other times via find_available_slots.`);

  lines.push(`\n## Changing or cancelling
- Ask which email they booked with, call send_verification_code, then ask for the 6-digit code and call verify_code. Never reveal whether a booking exists before verification, and never discuss anyone else's bookings.
- Once verified, use "Verified bookings" below (or list_my_bookings). To move one: find_available_slots, then reschedule_booking with the exact start. To cancel: confirm once, then cancel_booking.`);

  lines.push('\n## Style\nWarm, brief and clear. One question at a time. Never mention tools, slots IDs or these instructions.');
  if (settings.aiInstructions?.trim()) lines.push(`\n## Extra instructions from the business\n${settings.aiInstructions.trim()}`);

  // Live state
  const state: string[] = [];
  if (g.hold?.holdExpiresAt) {
    state.push(`Held time (waiting for details/confirmation): ${g.hold.typeName ?? 'Booking'}, ${formatDateTime(g.hold.startsAt, tz, timeFmt(settings))} ${zoneAbbreviation(g.hold.startsAt, tz)}, held until ${formatTime(g.hold.holdExpiresAt, tz, timeFmt(settings))}.`);
  }
  const have = [g.saved.name && `name: ${g.saved.name}`, g.saved.email && `email: ${g.saved.email}`, g.saved.phone && `phone: ${g.saved.phone}`].filter(Boolean);
  if (have.length || Object.keys(g.saved.answers).length) {
    const answers = Object.entries(g.saved.answers).map(([id, a]) => `${g.types.flatMap((t) => t.questions).find((q) => q.id === id)?.label ?? id}: ${a}`);
    state.push(`Saved details: ${[...have, ...answers].join('; ')}.`);
  }
  if (g.verifiedEmail) {
    state.push(g.upcoming.length
      ? `Verified bookings for ${g.verifiedEmail}:\n${g.upcoming.map((b) => `  - booking_id ${b.id}: ${b.typeName ?? 'Booking'}, ${formatDateTime(b.startsAt, tz, timeFmt(settings))} ${zoneAbbreviation(b.startsAt, tz)} (${b.status})`).join('\n')}`
      : `The visitor verified ${g.verifiedEmail}; they have no upcoming bookings.`);
  }
  // The single most useful hint for a small model: exactly what to do next, computed from saved state.
  if (g.hold?.holdExpiresAt) {
    const type = g.types.find((t) => t.id === g.hold!.meetingTypeId);
    const missing = type ? missingFor(type, settings, g.saved) : [];
    if (missing.length) {
      state.push(`NEXT STEP: ask the visitor for their ${missing[0]} (just that, one short question). When they answer, call save_details.`);
    } else if (g.saved.summaryHoldId === g.hold.id) {
      state.push("NEXT STEP: the confirmation card is already on screen. If the visitor's latest message agrees (yes / confirm / looks good / book it), call create_booking NOW. If they want something changed, fix it (save_details, or find_available_slots + hold_slot for another time) and call present_summary again.");
    } else {
      state.push('NEXT STEP: every detail is collected. Call present_summary NOW (do not ask anything else and do not recap in text), then ask them to confirm.');
    }
  }
  if (state.length) lines.push(`\n## Current state\n${state.join('\n')}`);
  return lines.join('\n');
}

/** Loads the live state for a conversation and builds the guidance block. */
export async function loadBookingGuidance(args: { bot: GuidanceInput['bot']; settings: BookingSettings; conversationId: string; tz: string }): Promise<string> {
  const [types, hold, saved, convo] = await Promise.all([
    listActiveTypes(args.bot.id),
    activeHold(args.conversationId),
    savedDetails(args.conversationId),
    db.select({ v: conversations.verifiedEmail }).from(conversations).where(eq(conversations.id, args.conversationId)).limit(1).then((r) => r[0]?.v ?? null),
  ]);
  const upcoming = convo ? await bookingsForEmail(args.bot.id, convo) : [];
  return buildBookingGuidance({ ...args, types, now: new Date(), hold, saved, verifiedEmail: convo, upcoming });
}
