import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, conversations, messages } from '../db/index.js';
import { eq, asc } from 'drizzle-orm';
import { streamSSE } from 'hono/streaming';
import { streamChat } from '../lib/bedrock.js';
import { Stopwatch } from '../lib/stopwatch.js';
import { getSettings } from '../booking/core.js';
import { tenantHasBooking } from '../booking/entitlements.js';
import { bookingToolSpecs } from '../booking/ai/tools.js';
import { prepareBookingTurn, type BookingTurn } from '../booking/ai/turn.js';
import { streamWithTools } from '../booking/ai/loop.js';
import type { BookingUiEvent } from '../booking/ai/ui-events.js';
import { safeTimezone } from '../booking/time.js';
import {
  addTenantTokens,
  buildSystemPrompt,
  conversationBelongsToBot,
  getActiveBot,
  getTenantUsage,
  isOriginAllowed,
  isOverTokenBudget,
  loadRecentHistory,
  loadVisitorContext,
  resolveConversation,
  resolveModelId,
  saveMessage,
  searchKnowledge,
  toSourceRefs,
  touchConversation,
} from '../lib/conversation.js';

const router = new Hono();

const chatSchema = z.object({
  botId: z.string().uuid(),
  message: z.string().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  visitorId: z.string().max(100).optional(),
  voice: z.boolean().optional(), // message came from the voice orb → answer for the ear
  timezone: z.string().max(64).optional(), // the visitor's IANA zone — times are shown/booked in it
  // Set when the visitor tapped a time card instead of typing; `message` is the human-readable echo.
  pickSlot: z.object({ start: z.string().max(40), typeName: z.string().max(100).optional() }).optional(),
  // Set when the visitor tapped the Confirm button on the confirmation card.
  action: z.literal('confirm').optional(),
});

// POST /api/chat — main chat endpoint, returns SSE stream
// This route is PUBLIC — no auth middleware, but we enforce domain locking
router.post('/', zValidator('json', chatSchema), async (c) => {
  const body = c.req.valid('json');
  const origin = c.req.header('Origin') ?? c.req.header('Referer') ?? '';
  const timing = new Stopwatch();

  const bot = await getActiveBot(body.botId);
  timing.mark('bot');
  if (!bot) return c.json({ error: 'Bot not found or inactive' }, 404);
  if (!isOriginAllowed(bot, origin)) return c.json({ error: 'Origin not allowed' }, 403);

  // Independent lookups run in parallel to keep time-to-first-token low.
  const [tenant, ownsConversation] = await Promise.all([
    getTenantUsage(bot.tenantId),
    body.conversationId ? conversationBelongsToBot(body.conversationId, bot.id) : Promise.resolve(false),
  ]);
  if (isOverTokenBudget(tenant)) return c.json({ error: 'Monthly token budget exceeded' }, 429);

  // An unknown/foreign conversation id starts a fresh conversation instead of leaking another's.
  const existingConversationId = ownsConversation ? body.conversationId : undefined;
  const conversationId = await resolveConversation(bot, {
    conversationId: existingConversationId,
    visitorId: body.visitorId,
  });
  timing.mark('setup');

  // History must be read BEFORE this turn's user message is saved, otherwise the new message can
  // appear in the history as well (two user turns in a row). Saving is chained after the read but
  // still overlaps the knowledge search.
  const historyP = loadRecentHistory(conversationId);
  const [history, visitorContext, sources] = await Promise.all([
    historyP,
    existingConversationId ? loadVisitorContext(conversationId) : Promise.resolve(''),
    searchKnowledge(bot, body.message).finally(() => timing.mark('rag')),
    historyP.then(() => saveMessage(conversationId, { role: 'user', content: body.message })),
  ]);
  timing.mark('context');

  // Bookings: only when this bot enabled it AND the plan allows it. Text chat only (voice has its own path).
  const bookingSettings = !body.voice ? await getSettings(bot.id) : undefined;
  const bookingOn = !!bookingSettings?.enabled && (await tenantHasBooking(bot.tenantId));
  const visitorTz = safeTimezone(body.timezone, safeTimezone(bookingSettings?.timezone));

  let systemPrompt = buildSystemPrompt({ bot, sources, visitorContext, voice: !!body.voice });
  const modelId = resolveModelId(bot, tenant);
  const clientIp = (c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() || undefined;

  // Booking: the server performs the unambiguous steps itself (hold a tapped time, book on Confirm) before the
  // model speaks. UI events raised before the stream opens are buffered and flushed as soon as it does.
  const uiBuffer: BookingUiEvent[] = [];
  let uiSink: ((event: BookingUiEvent) => void) | null = null;
  let bookedUi = false;
  const emitUi = (event: BookingUiEvent) => {
    if (event.kind === 'booked') bookedUi = true;
    if (uiSink) uiSink(event); else uiBuffer.push(event);
  };
  let bookingTurn: BookingTurn | undefined;
  if (bookingOn && bookingSettings) {
    bookingTurn = await prepareBookingTurn({
      bot, settings: bookingSettings, conversationId, visitorTz, clientIp, message: body.message,
      pickSlot: body.pickSlot, action: body.action, emit: emitUi,
    });
    systemPrompt += bookingTurn.systemSuffix;
  }

  // Stream response via SSE
  return streamSSE(c, async (stream) => {
    // One serialised writer: tool-emitted UI events and streamed text can't interleave mid-message.
    let chain: Promise<unknown> = Promise.resolve();
    const send = (payload: Record<string, unknown>) => (chain = chain.then(() => stream.writeSSE({ data: JSON.stringify(payload) })).catch(() => undefined));

    // Send conversationId first so the widget knows how to continue
    await send({ type: 'meta', conversationId });

    let fullResponse = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      uiSink = (event) => { void send({ type: 'booking_ui', ...event }); };
      while (uiBuffer.length) uiSink(uiBuffer.shift()!);

      const plainChat = (userMessage: string) => (async function* () {
        for await (const text of streamChat({ systemPrompt, history, userMessage, modelId, onTokenUsage: (inp, out) => { inputTokens = inp; outputTokens = out; } })) {
          yield { type: 'text' as const, text };
        }
      })();
      const source: AsyncIterable<{ type: 'text'; text: string } | { type: 'usage'; inputTokens: number; outputTokens: number }> =
        bookingTurn?.allowTools
          ? streamWithTools({
              systemPrompt, history, userMessage: bookingTurn.userMessage, modelId,
              tools: bookingToolSpecs(), runTool: bookingTurn.runTool, forceTool: bookingTurn.forceTool,
            })
          : plainChat(bookingTurn?.userMessage ?? body.message);

      for await (const ev of source) {
        if (ev.type === 'usage') { inputTokens += ev.inputTokens; outputTokens += ev.outputTokens; continue; }
        if (!fullResponse) timing.mark('firstToken');
        fullResponse += ev.text;
        await send({ type: 'chunk', text: ev.text });
      }

      // A booking was made but the model said nothing (rare): never leave the visitor in silence.
      if (!fullResponse.trim() && bookedUi) {
        fullResponse = "You're all set! A confirmation is on its way to your email.";
        await send({ type: 'chunk', text: fullResponse });
      }

      // Tell the widget we're done first (with sources for the citation UI), then persist.
      await send({ type: 'done', sources: sources.map((s) => ({ documentName: s.documentName, score: s.score })) });
      timing.mark('done');
      // One structured line per request, so latency can be diagnosed from the logs.
      console.log(JSON.stringify({ evt: 'chat_timing', botId: bot.id, model: modelId ?? 'default', voice: !!body.voice, booking: bookingOn, ...timing.toJSON() }));

      await Promise.all([
        saveMessage(conversationId, {
          role: 'assistant',
          content: fullResponse,
          sources: toSourceRefs(sources),
          inputTokens,
          outputTokens,
        }),
        addTenantTokens(bot.tenantId, inputTokens + outputTokens),
        touchConversation(conversationId, 2), // this user + assistant turn
      ]);
    } catch (err) {
      console.error('Chat stream error:', err);
      await send({ type: 'error', message: 'Something went wrong' });
    }
  });
});

// GET /api/chat/history/:conversationId — conversation history (for dashboard + widget resume)
router.get('/history/:conversationId', async (c) => {
  const { conversationId } = c.req.param();

  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));

  return c.json({ messages: msgs });
});

// PATCH /api/chat/lead — save visitor lead data from lead capture form (public)
router.patch('/lead', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.conversationId) return c.json({ error: 'conversationId required' }, 400);

  // Support new { fields } format and old { email, name } format
  let fields: Record<string, string> = {};
  if (body.fields && typeof body.fields === 'object') {
    fields = body.fields;
  } else if (body.email) {
    if (body.email) fields.email = body.email;
    if (body.name) fields.name = body.name;
  }

  if (Object.keys(fields).length === 0) return c.json({ error: 'At least one field required' }, 400);

  const updates: Record<string, any> = {};
  if (fields.email) {
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(fields.email)) return c.json({ error: 'Invalid email' }, 400);
    updates.visitorEmail = fields.email.trim();
  }
  if (fields.name) updates.visitorName = fields.name.trim() || null;
  if (fields.phone) updates.visitorPhone = fields.phone.trim() || null;

  // Any non-standard fields go into leadData JSONB
  const customEntries = Object.entries(fields).filter(([k]) => !['email', 'name', 'phone'].includes(k));
  if (customEntries.length > 0) {
    updates.leadData = Object.fromEntries(customEntries.map(([k, v]) => [k, String(v).trim()]));
  }

  const [conv] = await db.select({ id: conversations.id })
    .from(conversations).where(eq(conversations.id, body.conversationId)).limit(1);
  if (!conv) return c.json({ error: 'Not found' }, 404);

  await db.update(conversations).set(updates).where(eq(conversations.id, body.conversationId));
  return c.json({ success: true });
});

export default router;
