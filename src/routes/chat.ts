import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, conversations, messages } from '../db/index.js';
import { eq, asc } from 'drizzle-orm';
import { streamSSE } from 'hono/streaming';
import { streamChat } from '../lib/bedrock.js';
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
});

// POST /api/chat — main chat endpoint, returns SSE stream
// This route is PUBLIC — no auth middleware, but we enforce domain locking
router.post('/', zValidator('json', chatSchema), async (c) => {
  const body = c.req.valid('json');
  const origin = c.req.header('Origin') ?? c.req.header('Referer') ?? '';

  const bot = await getActiveBot(body.botId);
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

  // History must be read BEFORE this turn's user message is saved, otherwise the new message can
  // appear in the history as well (two user turns in a row). Saving is chained after the read but
  // still overlaps the knowledge search.
  const historyP = loadRecentHistory(conversationId);
  const [history, visitorContext, sources] = await Promise.all([
    historyP,
    existingConversationId ? loadVisitorContext(conversationId) : Promise.resolve(''),
    searchKnowledge(bot, body.message),
    historyP.then(() => saveMessage(conversationId, { role: 'user', content: body.message })),
  ]);

  const systemPrompt = buildSystemPrompt({ bot, sources, visitorContext, voice: !!body.voice });

  // Stream response via SSE
  return streamSSE(c, async (stream) => {
    // Send conversationId first so the widget knows how to continue
    await stream.writeSSE({
      data: JSON.stringify({ type: 'meta', conversationId }),
    });

    let fullResponse = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const chatStream = streamChat({
        systemPrompt,
        history,
        userMessage: body.message,
        modelId: resolveModelId(bot, tenant),
        onTokenUsage: (inp, out) => { inputTokens = inp; outputTokens = out; },
      });

      for await (const chunk of chatStream) {
        fullResponse += chunk;
        await stream.writeSSE({
          data: JSON.stringify({ type: 'chunk', text: chunk }),
        });
      }

      // Tell the widget we're done first (with sources for the citation UI), then persist.
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'done',
          sources: sources.map((s) => ({ documentName: s.documentName, score: s.score })),
        }),
      });

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
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', message: 'Something went wrong' }),
      });
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
