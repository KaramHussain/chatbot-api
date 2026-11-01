// Converse tool-use loop: stream the model, run any tool calls it makes, feed the results back, and
// repeat until it answers in plain text. Text is yielded as it streams, so visitors see the same
// token-by-token reply as in a normal chat — tool rounds only add latency on turns that need them.
import type { ContentBlock, Message, StopReason } from '@aws-sdk/client-bedrock-runtime';
import { defaultLlmModel, openConverseStream, toConverseMessages, type ChatMessage } from '../../lib/bedrock.js';
import type { ToolSpec } from './tools.js';

export type LoopEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number };

export interface LoopOptions {
  systemPrompt: string;
  history: ChatMessage[];
  userMessage: string;
  modelId?: string;
  tools: ToolSpec[];
  runTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  maxRounds?: number;
  signal?: AbortSignal;
  /**
   * Force the model to call a specific tool at the start of a round, instead of choosing. Used where the
   * next step is not a judgement call (a tapped time must be held, a tapped Confirm must book) — a model
   * that is merely *asked* to call a tool can instead narrate that it did.
   */
  forceTool?: (round: number) => string | undefined;
}

interface Block { kind: 'text'; text: string }
interface ToolBlock { kind: 'tool'; id: string; name: string; json: string }

/**
 * Forcing a specific tool is model-specific on Bedrock: Nova honours `toolChoice: {tool}`, while Mistral
 * ignores it and honours `{any}` — so for Mistral only the forced tool is exposed, and `any` forces it.
 */
function toolConfigFor(modelId: string, tools: ToolSpec[], forced?: string) {
  if (!forced) return { tools };
  if (/mistral/i.test(modelId)) return { tools: tools.filter((t) => t.toolSpec.name === forced), toolChoice: { any: {} } };
  return { tools, toolChoice: { tool: { name: forced } } };
}

export async function* streamWithTools(opts: LoopOptions): AsyncGenerator<LoopEvent> {
  const modelId = opts.modelId ?? defaultLlmModel();
  const messages: Message[] = toConverseMessages(opts.history, opts.userMessage);
  if (!messages.length) return;
  const maxRounds = opts.maxRounds ?? 5;

  for (let round = 0; round < maxRounds; round++) {
    const forced = opts.forceTool?.(round);
    const open = (force?: string) => openConverseStream(modelId, {
      messages,
      system: [{ text: opts.systemPrompt }],
      toolConfig: toolConfigFor(modelId, opts.tools, force) as never,
      inferenceConfig: { maxTokens: 1024, temperature: 0.2 },
    }, opts.signal);
    // A model that rejects forced tool choice still works — it just chooses for itself.
    const res = await open(forced).catch((err: Error) => { if (forced && err.name === 'ValidationException') return open(); throw err; });
    if (!res.stream) return;

    const blocks = new Map<number, Block | ToolBlock>();
    let stopReason: StopReason | undefined;

    for await (const ev of res.stream) {
      const start = ev.contentBlockStart;
      if (start?.start?.toolUse && start.contentBlockIndex !== undefined) {
        blocks.set(start.contentBlockIndex, { kind: 'tool', id: start.start.toolUse.toolUseId ?? '', name: start.start.toolUse.name ?? '', json: '' });
      }
      const delta = ev.contentBlockDelta;
      if (delta?.contentBlockIndex !== undefined) {
        if (delta.delta?.text) {
          const b = (blocks.get(delta.contentBlockIndex) as Block | undefined) ?? { kind: 'text' as const, text: '' };
          b.text += delta.delta.text;
          blocks.set(delta.contentBlockIndex, b);
          yield { type: 'text', text: delta.delta.text };
        }
        if (delta.delta?.toolUse?.input !== undefined) {
          const b = blocks.get(delta.contentBlockIndex) as ToolBlock | undefined;
          if (b?.kind === 'tool') b.json += delta.delta.toolUse.input;
        }
      }
      if (ev.messageStop) stopReason = ev.messageStop.stopReason;
      if (ev.metadata?.usage) yield { type: 'usage', inputTokens: ev.metadata.usage.inputTokens ?? 0, outputTokens: ev.metadata.usage.outputTokens ?? 0 };
    }

    const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    const calls = ordered.filter((b): b is ToolBlock => b.kind === 'tool');
    if (stopReason !== 'tool_use' || !calls.length) return;

    const parse = (json: string): Record<string, unknown> => { try { return json ? JSON.parse(json) : {}; } catch { return {}; } };
    const assistant: ContentBlock[] = ordered.flatMap((b): ContentBlock[] =>
      b.kind === 'text' ? (b.text.trim() ? [{ text: b.text }] : []) : [{ toolUse: { toolUseId: b.id, name: b.name, input: parse(b.json) as never } }]);
    messages.push({ role: 'assistant', content: assistant });

    const results: ContentBlock[] = [];
    for (const call of calls) {
      const started = Date.now();
      const result = await opts.runTool(call.name, parse(call.json));
      const failed = typeof result === 'object' && result !== null && 'error' in result;
      console.log(JSON.stringify({ evt: 'booking_tool', tool: call.name, ms: Date.now() - started, ok: !failed }));
      results.push({ toolResult: { toolUseId: call.id, content: [{ json: result as never }], status: failed ? 'error' : 'success' } });
    }
    messages.push({ role: 'user', content: results });
  }
}
