// Public widget endpoint that starts a realtime voice call.
// POST /api/widget/voice/session → { serverUrl, participantToken, conversationId }
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  conversationBelongsToBot,
  getActiveBot,
  getTenantUsage,
  isOriginAllowed,
  isOverTokenBudget,
  resolveConversation,
} from '../lib/conversation.js';
import { isVoiceConfigured } from '../voice/config.js';
import { createVoiceSession } from '../voice/session.js';

const router = new Hono();

const sessionSchema = z.object({
  botId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  visitorId: z.string().max(100).optional(),
});

router.post('/session', zValidator('json', sessionSchema), async (c) => {
  if (!isVoiceConfigured()) return c.json({ error: 'Voice is not available' }, 503);

  const body = c.req.valid('json');
  const origin = c.req.header('Origin') ?? c.req.header('Referer') ?? '';

  const bot = await getActiveBot(body.botId);
  if (!bot) return c.json({ error: 'Bot not found or inactive' }, 404);
  if (!bot.voiceEnabled) return c.json({ error: 'Voice is not enabled for this bot' }, 403);
  if (!isOriginAllowed(bot, origin)) return c.json({ error: 'Origin not allowed' }, 403);

  const [tenant, ownsConversation] = await Promise.all([
    getTenantUsage(bot.tenantId),
    body.conversationId ? conversationBelongsToBot(body.conversationId, bot.id) : Promise.resolve(true),
  ]);
  if (isOverTokenBudget(tenant)) return c.json({ error: 'Monthly token budget exceeded' }, 429);

  // An unknown/foreign conversation id starts a fresh conversation instead of leaking another's.
  const conversationId = await resolveConversation(bot, {
    conversationId: ownsConversation ? body.conversationId : undefined,
    visitorId: body.visitorId,
  });

  try {
    const session = await createVoiceSession({ botId: bot.id, conversationId, visitorId: body.visitorId });
    c.header('Cache-Control', 'no-store');
    return c.json({ serverUrl: session.serverUrl, participantToken: session.participantToken, conversationId });
  } catch (err) {
    console.error('Voice session creation failed:', err);
    return c.json({ error: 'Could not start voice session' }, 502);
  }
});

export default router;
