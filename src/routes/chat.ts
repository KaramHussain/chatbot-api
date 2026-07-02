import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, bots, conversations, messages, tenants } from '../db/index.js';
import { eq, and, asc, sql } from 'drizzle-orm';
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
});

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

  // 1b. Load tenant to get AI model + token budget
  const [tenant] = await db
    .select({
      aiModel: tenants.aiModel,
      monthlyTokenBudget: tenants.monthlyTokenBudget,
      tokensUsedThisMonth: tenants.tokensUsedThisMonth,
    })
    .from(tenants)
    .where(eq(tenants.id, bot.tenantId))
    .limit(1);

  // Enforce token budget (0 = unlimited)
  if (tenant && tenant.monthlyTokenBudget > 0 && tenant.tokensUsedThisMonth >= tenant.monthlyTokenBudget) {
    return c.json({ error: 'Monthly token budget exceeded' }, 429);
  }

  // 2. Domain lock — verify request comes from an allowed origin
  if (bot.allowedOrigins.length > 0) {
    const allowed = bot.allowedOrigins.some((o) => origin.startsWith(o));
    if (!allowed) {
      return c.json({ error: 'Origin not allowed' }, 403);
    }
  }

  // 3. Get or create conversation
  let conversationId = body.conversationId;
  if (!conversationId) {
    const [newConv] = await db
      .insert(conversations)
      .values({
        botId: bot.id,
        tenantId: bot.tenantId,
        visitorId: body.visitorId,
      })
      .returning({ id: conversations.id });
    conversationId = newConv.id;
  }

  // 4. Load recent history (last 10 messages for context window)
  const history = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .limit(10);

  // 5. RAG retrieval
  let sources: ChatSource[] = [];
  try {
    sources = await retrieveContext({
      botId: bot.id,
      tenantId: bot.tenantId,
      query: body.message,
    });
  } catch (err) {
    console.error('RAG retrieval failed:', err);
    // Fall back to LLM-only chat — don't crash
  }

  // 6. Build system prompt with injected context
  const systemPrompt = buildRagPrompt({
    botSystemPrompt: bot.systemPrompt,
    sources,
    responseStyle: bot.responseStyle,
  });

  // 7. Save user message
  await db.insert(messages).values({
    conversationId,
    role: 'user',
    content: body.message,
  });

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
          messageCount: history.length + 2, // +2 for user+assistant
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

// PATCH /api/chat/lead — save visitor email/name from lead capture form (public)
router.patch('/lead', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.conversationId || !body?.email || !body?.name) {
    return c.json({ error: 'conversationId, email, and name are required' }, 400);
  }
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(body.email)) return c.json({ error: 'Invalid email' }, 400);

  const [conv] = await db.select({ id: conversations.id })
    .from(conversations).where(eq(conversations.id, body.conversationId)).limit(1);
  if (!conv) return c.json({ error: 'Not found' }, 404);

  await db.update(conversations)
    .set({ visitorEmail: body.email.trim(), visitorName: body.name.trim() || null })
    .where(eq(conversations.id, body.conversationId));

  return c.json({ success: true });
});

export default router;
