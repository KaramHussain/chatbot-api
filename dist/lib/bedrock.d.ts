import { ConverseStreamCommand, type ConverseStreamCommandOutput, type Message as BedrockMessage } from '@aws-sdk/client-bedrock-runtime';
export declare const defaultLlmModel: () => string;
export declare function embedText(text: string): Promise<number[]>;
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
export declare function toConverseMessages(history: ChatMessage[], userMessage: string): BedrockMessage[];
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
export declare function openConverseStream(chain: string[], input: ConverseStreamInput | ((modelId: string) => ConverseStreamInput), signal?: AbortSignal): Promise<ConverseStreamResult>;
export declare function streamChat(options: StreamChatOptions): AsyncGenerator<string>;
/**
 * Admin "Test" button: a minimal, real invoke of exactly this model id — no fallback, so a
 * denial/error is reported as-is rather than being masked by the chain.
 */
export declare function testModelInvoke(modelId: string): Promise<{
    ok: boolean;
    latencyMs: number;
    sample?: string;
    error?: string;
}>;
/**
 * One-shot, non-streaming completion for background jobs (e.g. summarising a conversation).
 * Uses the cheapest fast model by default; never use it on the live chat path.
 */
export declare function completeText(opts: {
    system: string;
    user: string;
    modelId?: string;
    maxTokens?: number;
}): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
}>;
//# sourceMappingURL=bedrock.d.ts.map