// The realtime voice agent. One job process handles one visitor's call:
//   visitor mic ─WebRTC─► Deepgram STT ─► our Bedrock+RAG brain ─► Deepgram Aura TTS ─WebRTC─► visitor
// Turn-taking, interruptions, audio transport and caption sync are handled by LiveKit Agents.
//
// This module is the job entrypoint loaded by the worker (see worker.ts). It must stay free of
// side effects at import time — the worker imports it in every job process.
import { type JobContext, type JobProcess, defineAgent, llm, log, voice } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as silero from '@livekit/agents-plugin-silero';
import {
  addTenantTokens,
  buildSystemPrompt,
  getActiveBot,
  getTenantUsage,
  loadRecentHistory,
  loadVisitorContext,
  resolveModelId,
  searchKnowledge,
} from '../lib/conversation.js';
import { resolveVoice } from '../lib/deepgram.js';
import { BedrockRagLLM, type VoiceBrain } from './bedrock-rag-llm.js';
import { REPLY_TOPIC, TURN_TUNING } from './config.js';
import { decodeJobMetadata } from './session.js';
import { speakableText } from './speech-text.js';
import { TranscriptRecorder } from './transcript-recorder.js';

interface ProcData {
  vad: silero.VAD;
}

export default defineAgent<ProcData>({
  // Runs once per job process before any call arrives, so loading the VAD model never delays a call.
  prewarm: async (proc: JobProcess<ProcData>) => {
    proc.userData.vad = (await silero.VAD.load()) as silero.VAD;
  },

  entry: async (ctx: JobContext<ProcData>) => {
    const logger = log().child({ room: ctx.room.name });
    const { botId, conversationId } = decodeJobMetadata(ctx.job.metadata);

    const bot = await getActiveBot(botId);
    if (!bot || !bot.voiceEnabled) {
      logger.warn({ botId }, 'voice requested for an inactive or voice-disabled bot — ending job');
      ctx.shutdown('bot unavailable');
      return;
    }

    const [tenant, visitorContext, history] = await Promise.all([
      getTenantUsage(bot.tenantId),
      loadVisitorContext(conversationId),
      loadRecentHistory(conversationId),
    ]);

    const brain: VoiceBrain = {
      modelId: resolveModelId(bot, tenant),
      systemPromptFor: async (userText) =>
        buildSystemPrompt({ bot, sources: await searchKnowledge(bot, userText), visitorContext, voice: true }),
      onUsage: (inputTokens, outputTokens) => {
        addTenantTokens(bot.tenantId, inputTokens + outputTokens).catch((err) =>
          logger.error({ err }, 'failed to record token usage'),
        );
      },
    };

    // Continue the visitor's existing (text) conversation, so the voice agent remembers it.
    const chatCtx = llm.ChatContext.empty();
    for (const turn of history) chatCtx.addMessage({ role: turn.role, content: turn.content });

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad,
      stt: new deepgram.STT({
        model: 'nova-3',
        language: 'en-US',
        smartFormat: true,
        punctuate: true,
        interimResults: true,
        endpointing: TURN_TUNING.sttEndpointingMs,
      }),
      llm: new BedrockRagLLM(brain),
      tts: new deepgram.TTS({ model: resolveVoice(bot.voiceId) }),
      // Never read links/emails/phone numbers aloud (they stay in the on-screen captions).
      ttsTextTransforms: [speakableText, 'filter_markdown', 'filter_emoji'],
      turnHandling: {
        turnDetection: 'stt',
        endpointing: {
          minDelay: TURN_TUNING.minEndpointingDelayMs,
          maxDelay: TURN_TUNING.maxEndpointingDelayMs,
        },
        interruption: { enabled: true, mode: 'vad', minDuration: TURN_TUNING.minInterruptionMs },
      },
    });

    // Persist only COMMITTED turns. Preemptive generation may draft several replies per turn;
    // only the one actually spoken reaches the chat context and is recorded here.
    const recorder = new TranscriptRecorder(conversationId, (err) => logger.error({ err }, 'transcript write failed'));
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) return;
      const text = item.textContent ?? '';
      recorder.record(item.role, text);
      // Hand the widget the complete committed reply — links included. The live captions are paced
      // to speech and can't be relied on to carry an unspoken link at the end of a reply.
      if (item.role === 'assistant' && text.trim()) {
        ctx.room.localParticipant
          ?.sendText(text, { topic: REPLY_TOPIC })
          .catch((err) => logger.warn({ err }, 'failed to send committed reply to widget'));
      }
    });
    session.on(voice.AgentSessionEventTypes.Error, (ev) => logger.error({ err: ev.error }, 'voice session error'));
    ctx.addShutdownCallback(() => recorder.flush());

    await ctx.connect();
    await session.start({
      // The brain builds the real system prompt per turn; these instructions are not sent to Bedrock.
      agent: new voice.Agent({ instructions: `Voice assistant for ${bot.displayName || bot.name}.`, chatCtx }),
      room: ctx.room,
      inputOptions: { closeOnDisconnect: true, deleteRoomOnClose: true },
      outputOptions: { transcriptionEnabled: true, syncTranscription: true },
    });
    logger.info({ botId, conversationId }, 'voice session started');
  },
});
