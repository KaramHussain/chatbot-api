import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseStreamCommandOutput,
  type Message as BedrockMessage,
} from '@aws-sdk/client-bedrock-runtime';
import { bedrockAwsConfig } from './aws.js';

const client = new BedrockRuntimeClient(bedrockAwsConfig);

const LLM_MODEL = process.env.BEDROCK_LLM_MODEL ?? 'us.amazon.nova-2-lite-v1:0';
const EMBED_MODEL = process.env.BEDROCK_EMBEDDING_MODEL ?? 'amazon.titan-embed-text-v2:0';
const EMBED_DIMS = parseInt(process.env.BEDROCK_EMBEDDING_DIMENSIONS ?? '1024');

export const defaultLlmModel = () => LLM_MODEL;

// ─── Embeddings ────────────────────────────────────────────────────────────────
export async function embedText(text: string): Promise<number[]> {
  const response = await client.send(
    new InvokeModelCommand({
      modelId: EMBED_MODEL,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: text,
        dimensions: EMBED_DIMS,
        normalize: true,
      }),
    })
  );

  const parsed = JSON.parse(new TextDecoder().decode(response.body));
  return parsed.embedding as number[];
}

// ─── Streaming Chat ─────────────────────────────────────────────────────────────
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamChatOptions {
  systemPrompt?: string;
  history: ChatMessage[];
  userMessage: string;
  /** A single model id, or an ordered fallback chain (tried in order on AccessDeniedException). */
  modelId?: string | string[];
  onTokenUsage?: (inputTokens: number, outputTokens: number) => void;
  /** Aborts the Bedrock request (e.g. the user interrupted the voice agent). */
  signal?: AbortSignal;
}

/**
 * Bedrock Converse requires a conversation that starts with the user and strictly alternates
 * user/assistant. Stored history can violate that (e.g. a reply that failed left two user turns in
 * a row), which makes Bedrock reject the whole request — so normalise defensively: drop empty
 * turns, drop leading assistant turns, and merge consecutive same-role turns.
 */
export function toConverseMessages(history: ChatMessage[], userMessage: string): BedrockMessage[] {
  const turns: ChatMessage[] = [];
  for (const m of [...history, { role: 'user' as const, content: userMessage }]) {
    const content = m.content.trim();
    if (!content) continue;
    if (!turns.length && m.role !== 'user') continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${content}`;
    else turns.push({ role: m.role, content });
  }
  return turns.map((m) => ({ role: m.role, content: [{ text: m.content }] }));
}

/** After a denial, skip the denied model for this long (avoids a wasted round-trip per message). */
const DENIED_RETRY_MS = 5 * 60_000;
const deniedUntil = new Map<string, number>();

/**
 * Whether to insert a Bedrock prompt-cache point after the system prompt for this model. Gated to
 * the expensive Claude models — the only ones here that both support `cachePoint` AND are costly
 * enough that caching the large static system prompt pays for itself (on a hit the cached prefix
 * bills at ~10% of normal input). Cheap Nova and non-caching Mistral are left untouched.
 *
 * We deliberately do NOT gate on prompt size. Measured against Opus 4.5 on Bedrock, the minimum
 * cacheable prefix is 4,096 tokens: below it the cache point is a silent no-op (0 cache
 * write/read, input billed normally — no premium), at/above it the prefix caches automatically.
 * So adding the point unconditionally costs nothing while the prompt is short and switches the
 * saving on by itself once the prompt grows past the minimum (e.g. an injected directory). The
 * system prompt is static between edits, so the cached prefix is reused across turns and chats.
 */
function shouldCacheSystemPrompt(modelId: string): boolean {
  return /anthropic\.claude/i.test(modelId);
}

export type ConverseStreamInput = Omit<ConstructorParameters<typeof ConverseStreamCommand>[0], 'modelId'>;
export interface ConverseStreamResult {
  response: ConverseStreamCommandOutput;
  /** Which model in the chain actually served this (for logging/cost attribution). */
  modelId: string;
}

/**
 * Tries each model in `chain` in order (deduplicated by the caller) — e.g. [opus, mistral, nova].
 * Falls through to the next one only on AccessDeniedException (a plan's model not entitled to this
 * AWS account, e.g. a pending Bedrock Marketplace subscription) so a chat never fails outright
 * because of model access; any other error (validation, throttling, etc.) is thrown immediately so
 * it isn't silently masked as "model unavailable". `input` may depend on which model is actually
 * being tried (e.g. forced-tool-use shape differs by provider) — pass a function for that.
 */
export async function openConverseStream(
  chain: string[],
  input: ConverseStreamInput | ((modelId: string) => ConverseStreamInput),
  signal?: AbortSignal,
): Promise<ConverseStreamResult> {
  const buildInput = typeof input === 'function' ? input : () => input;
  const models = chain.length ? chain : [LLM_MODEL];
  let lastErr: Error | undefined;

  for (let i = 0; i < models.length; i++) {
    const modelId = models[i];
    const isLast = i === models.length - 1;
    // Always give the last model in the chain a real attempt, even if it was recently denied —
    // it's the end of the line, so there's nowhere else to fall back to.
    if (!isLast && (deniedUntil.get(modelId) ?? 0) > Date.now()) continue;
    try {
      const response = await client.send(new ConverseStreamCommand({ ...buildInput(modelId), modelId }), { abortSignal: signal });
      return { response, modelId };
    } catch (err) {
      lastErr = err as Error;
      if ((err as Error).name !== 'AccessDeniedException' || isLast) throw err;
      deniedUntil.set(modelId, Date.now() + DENIED_RETRY_MS);
      console.warn(JSON.stringify({
        evt: 'model_fallback', modelId, next: models[i + 1], reason: (err as Error).message.slice(0, 160),
      }));
    }
  }
  // Unreachable in practice (the last iteration always returns or throws), but keeps TS happy.
  throw lastErr ?? new Error('No model available');
}

// Yields text delta chunks as strings; call this inside an SSE handler
export async function* streamChat(options: StreamChatOptions): AsyncGenerator<string> {
  const { systemPrompt, history, userMessage, modelId = LLM_MODEL, onTokenUsage, signal } = options;
  const chain = Array.isArray(modelId) ? modelId : [modelId];

  const messages = toConverseMessages(history, userMessage);
  if (!messages.length) return;

  // The system block can depend on which model in the chain actually serves the request: only the
  // expensive Claude models get a cache point appended (see shouldCacheSystemPrompt). The system
  // prompt is static between edits, so the cached prefix is reused across turns and conversations.
  const buildSystem = (id: string): ConverseStreamInput['system'] => {
    if (!systemPrompt) return undefined;
    if (shouldCacheSystemPrompt(id)) {
      return [{ text: systemPrompt }, { cachePoint: { type: 'default' } }];
    }
    return [{ text: systemPrompt }];
  };

  const { response } = await openConverseStream(chain, (id) => ({
    messages,
    system: buildSystem(id),
    inferenceConfig: {
      maxTokens: 2048,
      temperature: 0.2,
    },
  }), signal);

  if (!response.stream) return;

  for await (const event of response.stream) {
    if (event.contentBlockDelta?.delta?.text) {
      yield event.contentBlockDelta.delta.text;
    }
    if (event.metadata?.usage && onTokenUsage) {
      onTokenUsage(
        event.metadata.usage.inputTokens ?? 0,
        event.metadata.usage.outputTokens ?? 0,
      );
    }
  }
}

/**
 * Admin "Test" button: a minimal, real invoke of exactly this model id — no fallback, so a
 * denial/error is reported as-is rather than being masked by the chain.
 */
export async function testModelInvoke(modelId: string): Promise<{ ok: boolean; latencyMs: number; sample?: string; error?: string }> {
  const started = Date.now();
  try {
    const res = await client.send(new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: 'Reply with just the word OK.' }] }],
      inferenceConfig: { maxTokens: 10, temperature: 0 },
    }));
    const sample = (res.output?.message?.content ?? []).map((b) => b.text ?? '').join('').trim();
    return { ok: true, latencyMs: Date.now() - started, sample };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
  }
}

/**
 * One-shot, non-streaming completion for background jobs (e.g. summarising a conversation).
 * Uses the cheapest fast model by default; never use it on the live chat path.
 */
export async function completeText(opts: {
  system: string;
  user: string;
  modelId?: string;
  maxTokens?: number;
}): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const res = await client.send(new ConverseCommand({
    modelId: opts.modelId ?? 'us.amazon.nova-2-lite-v1:0',
    system: [{ text: opts.system }],
    messages: [{ role: 'user', content: [{ text: opts.user }] }],
    inferenceConfig: { maxTokens: opts.maxTokens ?? 400, temperature: 0.1 },
  }));
  const text = (res.output?.message?.content ?? []).map((b) => b.text ?? '').join('').trim();
  return { text, inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 };
}
