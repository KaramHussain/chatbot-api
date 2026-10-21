// Deepgram voice: Aura TTS (bot speaking) + Nova STT (user talking).
// REST only — no websocket/SDK needed. Only text is persisted; audio is transient.

const KEY = process.env.DEEPGRAM_API_KEY ?? '';
const TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL ?? 'aura-asteria-en';
const STT_MODEL = process.env.DEEPGRAM_STT_MODEL ?? 'nova-3';

const AURA_VOICES = new Set([
  'aura-asteria-en', 'aura-luna-en', 'aura-stella-en', 'aura-athena-en', 'aura-hera-en',
  'aura-orion-en', 'aura-arcas-en', 'aura-perseus-en', 'aura-angus-en', 'aura-orpheus-en',
  'aura-helios-en', 'aura-zeus-en',
]);

/** Text → MP3 bytes via Deepgram Aura. Falls back to the default voice for unknown ids. */
export async function ttsSpeak(text: string, voice?: string): Promise<Buffer> {
  if (!KEY) throw new Error('DEEPGRAM_API_KEY not set');
  const model = voice && AURA_VOICES.has(voice) ? voice : TTS_MODEL;
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3`, {
    method: 'POST',
    headers: { Authorization: `Token ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Deepgram TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Audio bytes → transcript via Deepgram Nova (pre-recorded). */
export async function sttTranscribe(audio: Buffer, contentType: string): Promise<string> {
  if (!KEY) throw new Error('DEEPGRAM_API_KEY not set');
  const res = await fetch(
    `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(STT_MODEL)}&smart_format=true&punctuate=true`,
    {
      method: 'POST',
      headers: { Authorization: `Token ${KEY}`, 'Content-Type': contentType || 'audio/webm' },
      body: audio,
    }
  );
  if (!res.ok) throw new Error(`Deepgram STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return data?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
}
