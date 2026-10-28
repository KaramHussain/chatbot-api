// Configuration for realtime voice (LiveKit media server + voice agent worker).
// Read lazily so importing this module never throws in processes that don't use voice.

export interface VoiceConfig {
  /** Public WebSocket URL browsers connect to, e.g. wss://voice.cloudgeniee.com */
  publicUrl: string;
  /** URL the agent worker uses to reach the LiveKit server (same host → plain loopback). */
  internalUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Explicit-dispatch name: only rooms that ask for this agent get it. */
  agentName: string;
}

export const VOICE_AGENT_NAME_DEFAULT = 'cloudgeniee-voice';

/** How long a widget join token stays valid. Only gates joining; the call itself can run longer. */
export const JOIN_TOKEN_TTL = '15m';

/**
 * Turn-taking tuning. Deepgram decides the user stopped talking after `sttEndpointingMs` of
 * silence, then the agent waits `minEndpointingDelayMs` more before replying — together ~0.5s
 * (product decision: snappy replies). Shorter means a mid-sentence pause may end the turn; if the
 * user keeps talking, the interruption handling stops the reply and listens again.
 */
export const TURN_TUNING = {
  sttEndpointingMs: 200,
  minEndpointingDelayMs: 300,
  maxEndpointingDelayMs: 3000,
  /** Speech shorter than this while the agent talks is not treated as an interruption. */
  minInterruptionMs: 500,
} as const;

let cached: VoiceConfig | null = null;

export function getVoiceConfig(): VoiceConfig {
  if (cached) return cached;
  const required = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Voice is not configured — missing env: ${missing.join(', ')}`);

  cached = {
    publicUrl: process.env.LIVEKIT_URL!,
    internalUrl: process.env.LIVEKIT_INTERNAL_URL ?? process.env.LIVEKIT_URL!,
    apiKey: process.env.LIVEKIT_API_KEY!,
    apiSecret: process.env.LIVEKIT_API_SECRET!,
    agentName: process.env.LIVEKIT_AGENT_NAME ?? VOICE_AGENT_NAME_DEFAULT,
  };
  return cached;
}

export function isVoiceConfigured(): boolean {
  return !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
}
