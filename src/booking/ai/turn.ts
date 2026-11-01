// Prepares one chat turn for a booking-enabled bot. The model is good at conversation and bad at
// reliably sequencing side effects, so everything that is NOT a judgement call is done here by the
// server before (or instead of) asking the model:
//   • a tapped time card      → the time is held directly
//   • Confirm tapped / "yes"  → the booking is created directly, the model only phrases the reply
//   • a visitor answering     → save_details is forced, which also shows the confirmation card
// The model handles the rest (understanding what the visitor wants, choosing slots, wording).
import { eq } from 'drizzle-orm';
import { conversations, db } from '../../db/index.js';
import type { Bot } from '../../lib/conversation.js';
import type { BookingSettings } from '../core.js';
import { getMeetingType } from '../core.js';
import { loadBookingGuidance } from './guidance.js';
import { handleManageTurn } from './manage.js';
import { activeHold, createToolRunner, missingFor, savedDetails, type ToolRunner } from './tools.js';
import type { EmitUi } from './ui-events.js';
import { formatDateTime, zoneAbbreviation } from '../time.js';

export interface BookingTurnInput {
  bot: Bot;
  settings: BookingSettings;
  conversationId: string;
  visitorTz: string;
  clientIp?: string;
  message: string;
  pickSlot?: { start: string; typeName?: string };
  action?: 'confirm';
  /** The bot's previous message in this conversation (to understand what the visitor is answering). */
  lastAssistant?: string;
  emit: EmitUi;
}

export interface BookingTurn {
  /** Appended to the system prompt (guidance + live state). */
  systemSuffix: string;
  /** The user message the model sees (may carry a note about what the server just did). */
  userMessage: string;
  /** false → answer in plain text with no tools (e.g. just phrase the confirmation). */
  allowTools: boolean;
  runTool: ToolRunner;
  forceTool: (round: number) => string | undefined;
}

/** The visitor is asking to start a booking (and not to change/cancel one). */
const BOOK_INTENT = /\b(book|schedule|reserve|arrange)\b|\b(want|need|like|can i|could i|may i|i'?d like|looking)\b[^.?!]*\b(appointment|meeting|consult\w*|slot|call|session|demo)\b|\bavailab(le|ility)\b/i;
const CHANGE_INTENT = /\b(cancel\w*|re-?schedul\w*|move|change)\b/i;
/** The message names a day, date, time or range ("Friday", "3pm", "after lunch", "5 Nov", "next week"). */
const PREFERENCE = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|sday|nesday|rsday|urday)?\b|\b(today|tomorrow|tonight|next week|this week|weekend|weekday|morning|afternoon|evening|noon|midday|lunch)\b|\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}(st|nd|rd|th)\b|\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\bmay\s+\d|\b(between|after|before|around|o'?clock)\b/i;
const UNSURE = /\b(not sure|unsure|don'?t know|dont know|no preference|any ?(time|day|slot)|anytime|whatever|anything|up to you|you (choose|pick|decide|tell me)|doesn'?t matter|flexible)\b/i;
const ASKED_PREFERENCE = /which (day|date)|what (day|date|time)|prefer|time range|full week|whole week/i;
const OFFERED_FULL_WEEK = /full week|whole week|entire week|all (of )?(the )?(open|available)/i;

const AFFIRMATIVE = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|confirm(ed)?|correct|that'?s (right|correct)|looks good|sounds good|book it|go ahead|please do|perfect|works for me)\b/i;

async function rememberedType(conversationId: string): Promise<string | undefined> {
  const [c] = await db.select({ lead: conversations.leadData }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  return (c?.lead as { lastTypeName?: string } | undefined)?.lastTypeName;
}

export async function prepareBookingTurn(input: BookingTurnInput): Promise<BookingTurn> {
  const runTool = createToolRunner({
    bot: input.bot, settings: input.settings, conversationId: input.conversationId, visitorTz: input.visitorTz, emit: input.emit, clientIp: input.clientIp,
  });
  const fmt = input.settings.timeFormat === '24h' ? '24h' : '12h';
  let note = '';
  let allowTools = true;
  let answering = true;

  const hold = await activeHold(input.conversationId);
  const saved = await savedDetails(input.conversationId);
  const summaryShown = !!hold && saved.summaryHoldId === hold.id;
  const wantsConfirm = input.action === 'confirm' || (summaryShown && input.message.length <= 60 && AFFIRMATIVE.test(input.message));

  // Changing/cancelling an existing booking is handled by the server first (code email, code check, cancel/move).
  const manage = await handleManageTurn({
    botId: input.bot.id, conversationId: input.conversationId, visitorTz: input.visitorTz, timeFormat: fmt, message: input.message,
    pickSlot: input.pickSlot, holdActive: !!hold,
  }, runTool);

  if (manage) {
    answering = false;
    note = manage.note;
    if (manage.allowTools === false) allowTools = false;
  } else if (input.pickSlot) {
    answering = false;
    const start = new Date(input.pickSlot.start);
    const r = (await runTool('hold_slot', { meeting_type: input.pickSlot.typeName, start: input.pickSlot.start })) as { held?: boolean; when?: string; error?: string };
    note = r.held
      ? `[The visitor tapped ${r.when ?? formatDateTime(start, input.visitorTz, fmt)} and it is now held for them for 10 minutes. Follow the NEXT STEP in "Current state".]`
      : `[The visitor tapped a time but it could not be held: ${r.error}. Apologise in a few words and offer other times with find_available_slots.]`;
  } else if (wantsConfirm) {
    answering = false;
    const r = (await runTool('create_booking', {})) as { booked?: boolean; status?: string; note?: string; error?: string; missing?: string[] };
    if (r.booked) {
      allowTools = false;
      note = `[The booking was just created (status: ${r.status}). ${r.note ?? ''} Reply in one or two short, warm sentences: it is booked and the invite is on its way. Do not call any tool and do not repeat the details.]`;
    } else {
      note = `[The booking could not be completed: ${r.error ?? 'unknown error'}${r.missing?.length ? ` (missing: ${r.missing.join(', ')})` : ''}. Apologise briefly and follow the NEXT STEP in "Current state".]`;
    }
  }

  // Ask-first search flow (only when no time is being held): preference -> exact answer; unsure -> offer the full week.
  let searchNow = false;
  if (answering && !hold) {
    const msg = input.message;
    const last = input.lastAssistant ?? '';
    const asked = ASKED_PREFERENCE.test(last);
    const wantsBook = BOOK_INTENT.test(msg) && !CHANGE_INTENT.test(msg);
    if (OFFERED_FULL_WEEK.test(last) && msg.length <= 60 && AFFIRMATIVE.test(msg)) {
      const lastType = await rememberedType(input.conversationId);
      await runTool('find_available_slots', { ...(lastType ? { meeting_type: lastType } : {}), full_week: true });
      answering = false;
      note = "[The full week's open times are now on screen as buttons. Say that in one short sentence and invite them to tap one, or tell you a day or time. Do not list the times.]";
    } else if ((wantsBook || asked) && PREFERENCE.test(msg)) {
      searchNow = true; // the model fills the search arguments from what they said
    } else if (asked && UNSURE.test(msg)) {
      note = "[The visitor isn't sure when. Ask exactly: \"Would you like me to send you the full week's available slots?\" (yes/no). Do not show or mention any times until they say yes.]";
    } else if (wantsBook) {
      note = "[The visitor wants to book. Do NOT show or mention any specific times yet. Ask ONE short question: which day or time they would prefer (a time range is fine) and — only if there are several meeting types — which one. Mention that if they are not sure you can send the full week's open times.]";
    }
  }

  // State is loaded AFTER the direct actions so the prompt reflects them.
  const systemSuffix = await loadBookingGuidance({ bot: input.bot, settings: input.settings, conversationId: input.conversationId, tz: input.visitorTz });

  // While a time is held and details are missing, an ordinary message is (almost always) an answer: force the
  // save so it is never lost to a model that only chats.
  const holdNow = await activeHold(input.conversationId);
  let forced: string | undefined;
  if (answering && allowTools && !holdNow && searchNow) {
    forced = 'find_available_slots'; // never left to the model: it will say "here are some times" without searching
  } else if (answering && allowTools && holdNow?.meetingTypeId) {
    const type = await getMeetingType(input.bot.id, holdNow.meetingTypeId);
    const missing = type ? missingFor(type, input.settings, await savedDetails(input.conversationId)) : [];
    if (missing.length) forced = 'save_details';
  }

  return {
    systemSuffix,
    userMessage: note ? `${input.message}\n\n${note}` : input.message,
    allowTools,
    runTool,
    forceTool: (round) => (round === 0 ? forced : undefined),
  };
}
