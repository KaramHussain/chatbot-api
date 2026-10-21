import { Hono } from 'hono';
import { db, bots } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { synthesizeSpeech } from '../lib/polly.js';

const router = new Hono();

const MAX_TTS_CHARS = 800;

// POST /api/widget/tts — public. Streams back MP3 audio for a sentence of bot text.
// Only used for live playback; nothing is stored.
router.post('/tts', async (c) => {
  let body: { botId?: string; text?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid body' }, 400); }

  const botId = body.botId?.trim();
  let text = (body.text ?? '').trim();
  if (!botId || !text) return c.json({ error: 'botId and text are required' }, 400);
  if (text.length > MAX_TTS_CHARS) text = text.slice(0, MAX_TTS_CHARS);

  const [bot] = await db
    .select({ id: bots.id, voiceEnabled: bots.voiceEnabled, voiceId: bots.voiceId })
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.status, 'active')))
    .limit(1);

  if (!bot) return c.json({ error: 'Bot not found' }, 404);
  if (!bot.voiceEnabled) return c.json({ error: 'Voice is not enabled for this bot' }, 403);

  try {
    const audio = await synthesizeSpeech(text, bot.voiceId);
    const ab = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
    c.header('Content-Type', 'audio/mpeg');
    c.header('Cache-Control', 'no-store, max-age=0');
    return c.body(ab);
  } catch (err: any) {
    console.error('TTS error:', err?.message ?? err);
    return c.json({ error: 'TTS failed' }, 502);
  }
});

export default router;
