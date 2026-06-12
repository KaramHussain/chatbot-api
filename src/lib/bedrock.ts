import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  ConverseStreamCommand,
  type Message as BedrockMessage,
} from '@aws-sdk/client-bedrock-runtime';
import { bedrockAwsConfig } from './aws.js';

const client = new BedrockRuntimeClient(bedrockAwsConfig);

const LLM_MODEL = process.env.BEDROCK_LLM_MODEL ?? 'amazon.nova-lite-v1:0';
const EMBED_MODEL = process.env.BEDROCK_EMBEDDING_MODEL ?? 'amazon.titan-embed-text-v2:0';
const EMBED_DIMS = parseInt(process.env.BEDROCK_EMBEDDING_DIMENSIONS ?? '1024');

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
  modelId?: string;
  onTokenUsage?: (inputTokens: number, outputTokens: number) => void;
}

// Yields text delta chunks as strings; call this inside an SSE handler
export async function* streamChat(options: StreamChatOptions): AsyncGenerator<string> {
  const { systemPrompt, history, userMessage, modelId = LLM_MODEL, onTokenUsage } = options;

  const messages: BedrockMessage[] = [
    ...history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: [{ text: m.content }],
    })),
    {
      role: 'user' as const,
      content: [{ text: userMessage }],
    },
  ];

  const system = systemPrompt
    ? [{ text: systemPrompt }]
    : undefined;

  const response = await client.send(
    new ConverseStreamCommand({
      modelId,
      messages,
      system,
      inferenceConfig: {
        maxTokens: 2048,
        temperature: 0.2,
      },
    })
  );

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
