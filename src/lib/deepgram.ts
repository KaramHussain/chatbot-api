// Deepgram voice: Aura-2 TTS (bot speaking) + Nova-3 STT (user talking).
// REST for TTS + prerecorded-STT fallback; browser streams live STT directly to
// Deepgram using a short-lived token minted by grantToken(). Only text is persisted.

const KEY = process.env.DEEPGRAM_API_KEY ?? '';
const TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL ?? 'aura-2-thalia-en';
const STT_MODEL = process.env.DEEPGRAM_STT_MODEL ?? 'nova-3';

const AURA_VOICES = new Set([
  // professional set shown in the dashboard
  'aura-2-thalia-en', 'aura-2-callista-en', 'aura-2-hera-en', 'aura-2-athena-en',
  'aura-2-pandora-en', 'aura-2-cora-en', 'aura-2-zeus-en', 'aura-2-saturn-en',
  'aura-2-arcas-en', 'aura-2-draco-en',
  // other valid Aura-2 voices we still accept (older bots / future use)
  'aura-2-andromeda-en', 'aura-2-helena-en', 'aura-2-aurora-en', 'aura-2-luna-en',
  'aura-2-apollo-en', 'aura-2-jupiter-en', 'aura-2-orion-en', 'aura-2-asteria-en',
  'aura-2-theia-en', 'aura-2-hyperion-en', 'aura-2-janus-en', 'aura-2-cordelia-en',
  'aura-2-vesta-en', 'aura-2-minerva-en', 'aura-2-odysseus-en', 'aura-2-harmonia-en',
  'aura-2-juno-en', 'aura-2-selene-en', 'aura-2-amalthea-en', 'aura-2-atlas-en',
  'aura-2-orpheus-en', 'aura-2-delia-en', 'aura-2-electra-en', 'aura-2-neptune-en',
  'aura-2-ophelia-en',
]);

function resolveVoice(voice?: string): string {
  if (voice && AURA_VOICES.has(voice)) return voice;
  // migrate old Aura-v1 ids like "aura-asteria-en" → closest Aura-2
  if (voice && voice.startsWith('aura-') && !voice.startsWith('aura-2-')) {
    const two = voice.replace('aura-', 'aura-2-');
    if (AURA_VOICES.has(two)) return two;
  }
  return TTS_MODEL;
}

// Slightly faster than default (1.0) for a snappier, more natural pace — "a little bit".
const TTS_SPEED = process.env.DEEPGRAM_TTS_SPEED ?? '1.12';

/** Text → MP3 bytes via Deepgram Aura-2. */
export async function ttsSpeak(text: string, voice?: string): Promise<Buffer> {
  if (!KEY) throw new Error('DEEPGRAM_API_KEY not set');
  const model = resolveVoice(voice);
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3&speed=${TTS_SPEED}`, {
    method: 'POST',
    headers: { Authorization: `Token ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Deepgram TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Audio bytes → transcript via Deepgram Nova (pre-recorded fallback). */
export async function sttTranscribe(audio: Buffer, contentType: string): Promise<string> {
  if (!KEY) throw new Error('DEEPGRAM_API_KEY not set');
  const res = await fetch(
    `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(STT_MODEL)}&smart_format=true&punctuate=true`,
    { method: 'POST', headers: { Authorization: `Token ${KEY}`, 'Content-Type': contentType || 'audio/webm' }, body: audio }
  );
  if (!res.ok) throw new Error(`Deepgram STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return data?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
}

/** Mint a short-lived token the browser uses to open a live STT websocket directly to Deepgram. */
export async function grantToken(ttlSeconds = 60): Promise<{ token: string; expiresIn: number }> {
  if (!KEY) throw new Error('DEEPGRAM_API_KEY not set');
  const res = await fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST',
    headers: { Authorization: `Token ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl_seconds: ttlSeconds }),
  });
  if (!res.ok) throw new Error(`Deepgram grant ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return { token: data.access_token, expiresIn: data.expires_in ?? ttlSeconds };
}
