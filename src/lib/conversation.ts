// Conversation domain logic shared by every channel that talks to a bot — the text chat route
// and the realtime voice agent. Keeping it in one place guarantees both channels build the
// same prompt, read the same history, and persist turns the same way.
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, bots, conversations, messages, tenants } from '../db/index.js';
import { buildRagPrompt, retrieveContext } from './rag.js';
import type { ChatSource } from '../types/index.js';

export type Bot = typeof bots.$inferSelect;
export type TurnRole = 'user' | 'assistant';
export interface Turn {
  role: TurnRole;
  content: string;
}

export interface TenantUsage {
  aiModel: string | null;
  monthlyTokenBudget: number;
  tokensUsedThisMonth: number;
}

/** Appended to the system prompt when the user is talking (not typing) to the bot. */
export const VOICE_GUIDANCE = `\n\n# Voice conversation mode
The user is SPEAKING to you and will HEAR your reply read aloud, while also SEEING the text on screen. Therefore:
- Keep replies short and natural — usually 1 to 3 spoken sentences. No long lists.
- When you point them to a web page, say: "You can find more information on the link provided on screen." Then put the full URL as the very LAST thing in your reply. The URL is shown on screen and is never read aloud, so never spell it out or describe it ("h t t p s", "dot com", etc.), and never say "tap" or "click".
- For an email address or phone number, refer to it as "the email address on screen" / "the number on screen" and include it in the text; never read its characters or digits out.
- Write plainly: no markdown, no asterisks, no bullet symbols, no code blocks, no headings. Just spoken sentences (a bare URL on its own is fine).
- Sound warm, human, and conversational, like a helpful support agent on a call.`;

const HISTORY_LIMIT = 10;

export async function getActiveBot(botId: string): Promise<Bot | undefined> {
  const [bot] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.status, 'active')))
    .limit(1);
  return bot;
}

/** Domain lock: an empty allow-list means the bot may be embedded anywhere. */
export function isOriginAllowed(bot: Bot, origin: string): boolean {
  if (bot.allowedOrigins.length === 0) return true;
  return bot.allowedOrigins.some((o) => origin.startsWith(o));
}

export async function getTenantUsage(tenantId: string): Promise<TenantUsage | undefined> {
  const [tenant] = await db
    .select({
      aiModel: tenants.aiModel,
      monthlyTokenBudget: tenants.monthlyTokenBudget,
      tokensUsedThisMonth: tenants.tokensUsedThisMonth,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return tenant;
}

/** A budget of 0 means unlimited. */
export function isOverTokenBudget(tenant: TenantUsage | undefined): boolean {
  return !!tenant && tenant.monthlyTokenBudget > 0 && tenant.tokensUsedThisMonth >= tenant.monthlyTokenBudget;
}

/** The bot's own model wins, then the tenant's; undefined falls back to the Bedrock default. */
export function resolveModelId(bot: Bot, tenant: TenantUsage | undefined): string | undefined {
  return bot.llmModel ?? tenant?.aiModel ?? undefined;
}

/** Returns the given conversation id, or creates a new conversation for this bot. */
export async function resolveConversation(
  bot: Bot,
  opts: { conversationId?: string; visitorId?: string },
): Promise<string> {
  if (opts.conversationId) return opts.conversationId;
  const [conv] = await db
    .insert(conversations)
    .values({ botId: bot.id, tenantId: bot.tenantId, visitorId: opts.visitorId })
    .returning({ id: conversations.id });
  return conv.id;
}

/** Guards against a client passing another bot's (or tenant's) conversation id. */
export async function conversationBelongsToBot(conversationId: string, botId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.botId, botId)))
    .limit(1);
  return !!row;
}

/** The most recent turns in chronological order. */
export async function loadRecentHistory(conversationId: string, limit = HISTORY_LIMIT): Promise<Turn[]> {
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse().map((r) => ({ role: r.role as TurnRole, content: r.content }));
}

/**
 * Prompt block describing what the visitor already told us (lead form), so the bot greets them by
 * name and doesn't ask again. Empty string when nothing is known.
 */
export async function loadVisitorContext(conversationId: string): Promise<string> {
  const [conv] = await db
    .select({
      name: conversations.visitorName,
      email: conversations.visitorEmail,
      phone: conversations.visitorPhone,
      leadData: conversations.leadData,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) return '';

  const parts: string[] = [];
  if (conv.name) parts.push(`name is ${conv.name}`);
  if (conv.email) parts.push(`email is ${conv.email}`);
  if (conv.phone) parts.push(`phone is ${conv.phone}`);
  if (conv.leadData && typeof conv.leadData === 'object') {
    for (const [k, v] of Object.entries(conv.leadData as Record<string, unknown>)) {
      if (v) parts.push(`${k} is ${v}`);
    }
  }
  if (!parts.length) return '';
  return `\n\n# Visitor\nThe visitor's ${parts.join(', ')}. Address them by their first name naturally and don't ask again for details they've already given.`;
}

/** Document search for a user query. Never throws — a failed search degrades to "no context". */
export async function searchKnowledge(bot: Bot, query: string): Promise<ChatSource[]> {
  try {
    return await retrieveContext({ botId: bot.id, tenantId: bot.tenantId, query });
  } catch (err) {
    console.error('RAG retrieval failed:', err);
    return [];
  }
}

export function buildSystemPrompt(params: {
  bot: Bot;
  sources: ChatSource[];
  visitorContext: string;
  voice: boolean;
}): string {
  let prompt = buildRagPrompt({
    botSystemPrompt: params.bot.systemPrompt,
    sources: params.sources,
    responseStyle: params.bot.responseStyle,
  });
  if (params.visitorContext) prompt += params.visitorContext;
  if (params.voice) prompt += VOICE_GUIDANCE;
  return prompt;
}

/** Compact source references stored with an assistant message (for citations / analytics). */
export function toSourceRefs(sources: ChatSource[]) {
  return sources.map((s) => ({ documentId: s.documentId, documentName: s.documentName, score: s.score }));
}

export async function saveMessage(
  conversationId: string,
  msg: {
    role: TurnRole;
    content: string;
    sources?: ReturnType<typeof toSourceRefs>;
    inputTokens?: number;
    outputTokens?: number;
  },
): Promise<void> {
  await db.insert(messages).values({
    conversationId,
    role: msg.role,
    content: msg.content,
    sources: msg.sources ?? [],
    inputTokens: msg.inputTokens ?? 0,
    outputTokens: msg.outputTokens ?? 0,
  });
}

/** Bump the conversation's message counter and activity timestamp. */
export async function touchConversation(conversationId: string, messagesAdded: number): Promise<void> {
  await db
    .update(conversations)
    .set({
      messageCount: sql`${conversations.messageCount} + ${messagesAdded}`,
      lastMessageAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));
}

/** Charge LLM tokens against the tenant's monthly budget. */
export async function addTenantTokens(tenantId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  await db
    .update(tenants)
    .set({ tokensUsedThisMonth: sql`${tenants.tokensUsedThisMonth} + ${tokens}` })
    .where(eq(tenants.id, tenantId));
}
