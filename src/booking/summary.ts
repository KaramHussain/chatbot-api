// A short AI summary of the conversation that led to a booking — what the visitor wanted — shown in
// the booking detail and the owner's email. Runs as a background job; failure never affects the booking.
import { asc, eq } from 'drizzle-orm';
import { db, messages } from '../db/index.js';
import { completeText } from '../lib/bedrock.js';
import { addTenantTokens } from '../lib/conversation.js';
import { bookings, type AiSummary } from './schema.js';

const SYSTEM = `You summarise a website-chat conversation for a business owner who just received a booking.
Reply with ONLY compact JSON: {"intent": string, "keyFacts": string[], "questions": string[], "sentiment": "positive"|"neutral"|"negative"}.
- intent: one sentence on WHY the visitor wants this meeting, from what they said beyond the booking itself (their problem, interest, budget, urgency). If they only asked to book with no context, write "Booked directly without further context."
- keyFacts: up to 4 useful things they shared that the owner should know before the meeting. NEVER include the booking logistics (the chosen time, their name, their email or phone) — the owner already has those. Use [] if there is nothing else.
- questions: up to 3 questions they asked the bot (not booking questions like "what is your email"). [] if none.
Use only facts stated in the conversation. Do not invent anything. No markdown.`;

export function parseSummary(raw: string): AiSummary | null {
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const arr = (v: unknown, n: number) => (Array.isArray(v) ? v.map(String).map((x) => x.slice(0, 200)).slice(0, n) : []);
    const intent = typeof o.intent === 'string' ? o.intent.slice(0, 300) : undefined;
    const sentiment = ['positive', 'neutral', 'negative'].includes(String(o.sentiment)) ? String(o.sentiment) : undefined;
    if (!intent && !arr(o.keyFacts, 4).length) return null;
    return { intent, keyFacts: arr(o.keyFacts, 4), questions: arr(o.questions, 3), sentiment };
  } catch {
    return null;
  }
}

export async function summariseBooking(bookingId: string): Promise<void> {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  if (!b?.conversationId || b.aiSummary) return;

  const turns = await db.select({ role: messages.role, content: messages.content }).from(messages)
    .where(eq(messages.conversationId, b.conversationId)).orderBy(asc(messages.createdAt)).limit(40);
  if (turns.length < 2) return;

  const transcript = turns.map((t) => `${t.role === 'user' ? 'Visitor' : 'Bot'}: ${t.content.slice(0, 600)}`).join('\n').slice(0, 9000);
  const { text, inputTokens, outputTokens } = await completeText({ system: SYSTEM, user: transcript, maxTokens: 350 });
  await addTenantTokens(b.tenantId, inputTokens + outputTokens).catch(() => undefined);
  const summary = parseSummary(text);
  if (summary) await db.update(bookings).set({ aiSummary: summary }).where(eq(bookings.id, bookingId));
}
