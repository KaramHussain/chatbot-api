import { Hono } from 'hono';
import { db, bots } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { ttsSpeak, sttTranscribe } from '../lib/deepgram.js';

const router = new Hono();

const MAX_TTS_CHARS = 800;
const MAX_STT_BYTES = 8 * 1024 * 1024; // 8 MB per utterance

async function activeVoiceBot(botId: string) {
  const [bot] = await db
    .select({ id: bots.id, voiceEnabled: bots.voiceEnabled, voiceId: bots.voiceId })
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.status, 'active')))
    .limit(1);
  return bot;
}

// POST /api/widget/tts — public. Streams back MP3 (Deepgram Aura) for a sentence of bot text.
router.post('/tts', async (c) => {
  let body: { botId?: string; text?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid body' }, 400); }

  const botId = body.botId?.trim();
  let text = (body.text ?? '').trim();
  if (!botId || !text) return c.json({ error: 'botId and text are required' }, 400);
  if (text.length > MAX_TTS_CHARS) text = text.slice(0, MAX_TTS_CHARS);

  const bot = await activeVoiceBot(botId);
  if (!bot) return c.json({ error: 'Bot not found' }, 404);
  if (!bot.voiceEnabled) return c.json({ error: 'Voice is not enabled for this bot' }, 403);

  try {
    const audio = await ttsSpeak(text, bot.voiceId);
    const ab = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
    c.header('Content-Type', 'audio/mpeg');
    c.header('Cache-Control', 'no-store, max-age=0');
    return c.body(ab);
  } catch (err: any) {
    console.error('TTS error:', err?.message ?? err);
    return c.json({ error: 'TTS failed' }, 502);
  }
});

// POST /api/widget/stt — public. Body = raw audio (webm/ogg/wav). Returns { transcript }.
router.post('/stt', async (c) => {
  const botId = (c.req.query('botId') ?? '').trim();
  if (!botId) return c.json({ error: 'botId required' }, 400);

  const bot = await activeVoiceBot(botId);
  if (!bot) return c.json({ error: 'Bot not found' }, 404);
  if (!bot.voiceEnabled) return c.json({ error: 'Voice is not enabled for this bot' }, 403);

  const contentType = c.req.header('content-type') || 'audio/webm';
  const audio = Buffer.from(await c.req.arrayBuffer());
  if (!audio.length) return c.json({ error: 'empty audio' }, 400);
  if (audio.length > MAX_STT_BYTES) return c.json({ error: 'audio too large' }, 413);

  try {
    const transcript = await sttTranscribe(audio, contentType);
    return c.json({ transcript });
  } catch (err: any) {
    console.error('STT error:', err?.message ?? err);
    return c.json({ error: 'STT failed' }, 502);
  }
});

export default router;
