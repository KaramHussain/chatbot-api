// LiveKit LLM plugin backed by our own Bedrock + knowledge-search "brain".
//
// The agent framework owns the conversation (chat context, interruptions, preemptive generation,
// retries); this class only turns the latest user utterance into a streamed Bedrock reply. It is
// deliberately free of database code — everything bot-specific comes in through `VoiceBrain`.
import { APIConnectionError, DEFAULT_API_CONNECT_OPTIONS, llm, shortuuid } from '@livekit/agents';
import type { APIConnectOptions } from '@livekit/agents';
import { streamChat, type ChatMessage } from '../lib/bedrock.js';

/** Bot-specific knowledge the LLM needs for each turn. */
export interface VoiceBrain {
  /** Bedrock model id (undefined → Bedrock default). */
  readonly modelId?: string;
  /** System prompt for this turn — runs the knowledge search for `userText`. */
  systemPromptFor(userText: string): Promise<string>;
  /** Called once per completed Bedrock request with its token usage. */
  onUsage?(inputTokens: number, outputTokens: number): void;
}

/** Splits the framework's chat context into prior turns + the utterance to answer. */
export function splitChatContext(chatCtx: llm.ChatContext): { history: ChatMessage[]; userText: string } {
  const turns: ChatMessage[] = [];
  for (const item of chatCtx.items) {
    if (item.type !== 'message') continue;
    if (item.role !== 'user' && item.role !== 'assistant') continue; // system/developer handled by us
    const content = item.textContent?.trim();
    if (content) turns.push({ role: item.role, content });
  }
  const last = turns[turns.length - 1];
  if (!last || last.role !== 'user') return { history: turns, userText: '' };
  return { history: turns.slice(0, -1), userText: last.content };
}

export class BedrockRagLLM extends llm.LLM {
  constructor(private readonly brain: VoiceBrain) {
    super();
  }

  label(): string {
    return 'cloudgeniee.BedrockRagLLM';
  }

  get model(): string {
    return this.brain.modelId ?? 'bedrock-default';
  }

  get provider(): string {
    return 'aws-bedrock';
  }

  chat({ chatCtx, toolCtx, connOptions }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContextLike;
    connOptions?: APIConnectOptions;
  }): llm.LLMStream {
    return new BedrockRagStream(this, this.brain, {
      chatCtx,
      toolCtx,
      connOptions: connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    });
  }
}

class BedrockRagStream extends llm.LLMStream {
  constructor(
    llmInstance: BedrockRagLLM,
    private readonly brain: VoiceBrain,
    opts: { chatCtx: llm.ChatContext; toolCtx?: llm.ToolContextLike; connOptions: APIConnectOptions },
  ) {
    super(llmInstance, opts);
  }

  protected async run(): Promise<void> {
    const signal = this.abortController.signal;
    const { history, userText } = splitChatContext(this.chatCtx);
    if (!userText) return;

    const requestId = shortuuid('bedrock_');
    let inputTokens = 0;
    let outputTokens = 0;
    let emitted = false;

    try {
      const systemPrompt = await this.brain.systemPromptFor(userText);
      if (signal.aborted) return;

      for await (const text of streamChat({
        systemPrompt,
        history,
        userMessage: userText,
        modelId: this.brain.modelId,
        signal,
        onTokenUsage: (inp, out) => { inputTokens = inp; outputTokens = out; },
      })) {
        if (signal.aborted) return;
        emitted = true;
        this.queue.put({ id: requestId, delta: { role: 'assistant', content: text } });
      }
    } catch (err) {
      if (signal.aborted) return; // interrupted by the user — not an error
      // Retrying is only safe before anything was spoken; afterwards it would repeat words.
      throw new APIConnectionError({
        message: `Bedrock request failed: ${(err as Error)?.message ?? err}`,
        options: { retryable: !emitted },
      });
    }

    if (inputTokens + outputTokens > 0) {
      this.queue.put({
        id: requestId,
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          promptCachedTokens: 0,
          totalTokens: inputTokens + outputTokens,
        },
      });
      this.brain.onUsage?.(inputTokens, outputTokens);
    }
  }
}
