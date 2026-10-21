import { PollyClient, SynthesizeSpeechCommand, type Engine, type VoiceId } from '@aws-sdk/client-polly';
import { awsConfig } from './aws.js';

// Polly lives in the main (infra) account — reuse awsConfig (instance role in prod).
const client = new PollyClient({
  ...awsConfig,
  region: process.env.POLLY_REGION ?? awsConfig.region,
});

const DEFAULT_VOICE = (process.env.POLLY_VOICE_ID ?? 'Joanna') as VoiceId;
const DEFAULT_ENGINE = (process.env.POLLY_ENGINE ?? 'neural') as Engine;

/** Synthesize speech → MP3 bytes. Only short, sentence-sized text should be passed. */
export async function synthesizeSpeech(text: string, voiceId?: string, engine?: string): Promise<Buffer> {
  const res = await client.send(new SynthesizeSpeechCommand({
    Text: text,
    OutputFormat: 'mp3',
    VoiceId: (voiceId as VoiceId) || DEFAULT_VOICE,
    Engine: (engine as Engine) || DEFAULT_ENGINE,
  }));
  if (!res.AudioStream) throw new Error('Polly returned no audio');
  const bytes = await res.AudioStream.transformToByteArray();
  return Buffer.from(bytes);
}
