// Creates a voice session for a widget visitor: a private LiveKit room with our voice agent
// explicitly dispatched into it, plus the short-lived token the browser joins with.
import { randomUUID } from 'node:crypto';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import { getVoiceConfig, JOIN_TOKEN_TTL } from './config.js';

/** What the agent needs to know about the call. Travels as the dispatch's JSON metadata. */
export interface VoiceJobMetadata {
  botId: string;
  conversationId: string;
}

export function encodeJobMetadata(meta: VoiceJobMetadata): string {
  return JSON.stringify(meta);
}

export function decodeJobMetadata(raw: string | undefined): VoiceJobMetadata {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? ''); } catch { throw new Error('Voice job metadata is not valid JSON'); }
  const m = parsed as Partial<VoiceJobMetadata>;
  if (typeof m?.botId !== 'string' || typeof m?.conversationId !== 'string') {
    throw new Error('Voice job metadata is missing botId/conversationId');
  }
  return { botId: m.botId, conversationId: m.conversationId };
}

export interface VoiceSession {
  serverUrl: string;
  roomName: string;
  participantToken: string;
}

export async function createVoiceSession(params: {
  botId: string;
  conversationId: string;
  visitorId?: string;
}): Promise<VoiceSession> {
  const cfg = getVoiceConfig();
  // Unguessable per-call room: nobody else can join, and nothing is shared between calls.
  const roomName = `cg-voice-${randomUUID()}`;
  const identity = `visitor-${params.visitorId?.slice(0, 32) || randomUUID()}`;

  const at = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity, ttl: JOIN_TOKEN_TTL });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,      // microphone
    canSubscribe: true,    // agent's voice
    canPublishData: true,  // text streams (transcripts)
  });
  at.roomConfig = new RoomConfiguration({
    agents: [
      new RoomAgentDispatch({
        agentName: cfg.agentName,
        metadata: encodeJobMetadata({ botId: params.botId, conversationId: params.conversationId }),
      }),
    ],
  });

  return { serverUrl: cfg.publicUrl, roomName, participantToken: await at.toJwt() };
}
