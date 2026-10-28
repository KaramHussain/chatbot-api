import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, bots, conversations, messages, tenants } from '../db/index.js';
import { eq, and, asc, desc, sql } from 'drizzle-orm';
import { streamSSE } from 'hono/streaming';
import { retrieveContext, buildRagPrompt } from '../lib/rag.js';
import { streamChat } from '../lib/bedrock.js';
import type { ChatSource } from '../types/index.js';

const router = new Hono();

const chatSchema = z.object({
  botId: z.string().uuid(),
  message: z.string().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  visitorId: z.string().max(100).optional(),
  voice: z.boolean().optional(), // message came from the voice orb → answer for the ear
});

const VOICE_GUIDANCE = `\n\n# Voice conversation mode
The user is SPEAKING to you and will HEAR your reply read aloud, while also SEEING the text on screen. Therefore:
- Keep replies short and natural — usually 1 to 3 spoken sentences. No long lists.
- When you point them to a web page, DO include the real URL at the end of your reply (it appears on their screen as a tappable link they can open). But phrase the sentence naturally, like: "Sure — here's the link to see all the details, just tap it:" followed by the URL. Never dictate/spell out the URL itself in words.
- Likewise you may include an email or phone number in the text, but don't read the characters out one by one — refer to it naturally.
- Write plainly: no markdown, no asterisks, no bullet symbols, no code blocks, no headings. Just spoken sentences (a bare URL on its own is fine).
- Sound warm, human, and conversational, like a helpful support agent on a call.`;

// POST /api/chat — main chat endpoint, returns SSE stream
// This route is PUBLIC — no auth middleware, but we enforce domain locking
router.post('/', zValidator('json', chatSchema), async (c) => {
  const body = c.req.valid('json');
  const origin = c.req.header('Origin') ?? c.req.header('Referer') ?? '';

  // 1. Load bot config
  const [bot] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.id, body.botId), eq(bots.status, 'active')))
    .limit(1);

  if (!bot) {
    return c.json({ error: 'Bot not found or inactive' }, 404);
  }

  // Domain lock — verify request comes from an allowed origin (no DB, do it immediately)
  if (bot.allowedOrigins.length > 0) {
    const allowed = bot.allowedOrigins.some((o) => origin.startsWith(o));
    if (!allowed) {
      return c.json({ error: 'Origin not allowed' }, 403);
    }
  }

  // 1b + 3. Tenant lookup and conversation get/create are independent of each other — run in
  // parallel instead of one after another (this used to be ~8 sequential round-trips before the
  // first LLM token was even requested, which is why replies felt slow to start).
  const [tenant, conversationId] = await Promise.all([
    db.select({
        aiModel: tenants.aiModel,
        monthlyTokenBudget: tenants.monthlyTokenBudget,
        tokensUsedThisMonth: tenants.tokensUsedThisMonth,
      })
      .from(tenants)
      .where(eq(tenants.id, bot.tenantId))
      .limit(1)
      .then((r) => r[0]),
    body.conversationId
      ? Promise.resolve(body.conversationId)
      : db.insert(conversations)
          .values({ botId: bot.id, tenantId: bot.tenantId, visitorId: body.visitorId })
          .returning({ id: conversations.id })
          .then((r) => r[0].id),
  ]);

  // Enforce token budget (0 = unlimited)
  if (tenant && tenant.monthlyTokenBudget > 0 && tenant.tokensUsedThisMonth >= tenant.monthlyTokenBudget) {
    return c.json({ error: 'Monthly token budget exceeded' }, 429);
  }

  // 4. History, lead details, RAG retrieval, and saving the user's message are all independent
  // of each other — run them all in parallel rather than sequentially.
  const [recent, leadRow, sources] = await Promise.all([
    // Last 10 messages (newest, then put back in chronological order — asc+limit used to return
    // the OLDEST 10, so long chats lost all recent context).
    db.select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(10)
      .then((r) => r.reverse()),
    // Lead details the visitor already shared, so the bot knows who it's talking to (only
    // possible on an existing conversation — a brand-new one can't have any yet).
    body.conversationId
      ? db.select({
          name: conversations.visitorName,
          email: conversations.visitorEmail,
          phone: conversations.visitorPhone,
          leadData: conversations.leadData,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1)
        .then((r) => r[0])
      : Promise.resolve(undefined),
    retrieveContext({ botId: bot.id, tenantId: bot.tenantId, query: body.message })
      .catch((err) => { console.error('RAG retrieval failed:', err); return [] as ChatSource[]; }),
    db.insert(messages).values({ conversationId, role: 'user', content: body.message }),
  ]);

  const history = recent;
  // Bedrock Converse requires the first message to be from the user.
  while (history.length && history[0].role !== 'user') history.shift();

  let leadInfo = '';
  if (leadRow) {
    const parts: string[] = [];
    if (leadRow.name) parts.push(`name is ${leadRow.name}`);
    if (leadRow.email) parts.push(`email is ${leadRow.email}`);
    if (leadRow.phone) parts.push(`phone is ${leadRow.phone}`);
    if (leadRow.leadData && typeof leadRow.leadData === 'object') {
      for (const [k, v] of Object.entries(leadRow.leadData as Record<string, unknown>)) {
        if (v) parts.push(`${k} is ${v}`);
      }
    }
    if (parts.length) {
      leadInfo = `\n\n# Visitor\nThe visitor's ${parts.join(', ')}. Address them by their first name naturally and don't ask again for details they've already given.`;
    }
  }

  // Build system prompt with injected context
  let systemPrompt = buildRagPrompt({
    botSystemPrompt: bot.systemPrompt,
    sources,
    responseStyle: bot.responseStyle,
  });
  if (leadInfo) systemPrompt += leadInfo;
  if (body.voice) systemPrompt += VOICE_GUIDANCE;

  // 8. Stream response via SSE
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
        history: history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        userMessage: body.message,
        modelId: bot.llmModel ?? tenant?.aiModel ?? undefined,
        onTokenUsage: (inp, out) => { inputTokens = inp; outputTokens = out; },
      });

      for await (const chunk of chatStream) {
        fullResponse += chunk;
        await stream.writeSSE({
          data: JSON.stringify({ type: 'chunk', text: chunk }),
        });
      }

      // Save assistant message with token counts
      await db.insert(messages).values({
        conversationId,
        role: 'assistant',
        content: fullResponse,
        sources: sources.map((s) => ({
          documentId: s.documentId,
          documentName: s.documentName,
          score: s.score,
        })),
        inputTokens,
        outputTokens,
      });

      // Update tenant token counter
      if (inputTokens + outputTokens > 0) {
        await db.update(tenants)
          .set({ tokensUsedThisMonth: sql`${tenants.tokensUsedThisMonth} + ${inputTokens + outputTokens}` })
          .where(eq(tenants.id, bot.tenantId));
      }

      // Update conversation stats
      await db
        .update(conversations)
        .set({
          messageCount: sql`${conversations.messageCount} + 2`, // +2 for this user+assistant turn
          lastMessageAt: new Date(),
        })
        .where(eq(conversations.id, conversationId));

      // Send done event with sources for citation UI
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'done',
          sources: sources.map((s) => ({
            documentName: s.documentName,
            score: s.score,
          })),
        }),
      });
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
